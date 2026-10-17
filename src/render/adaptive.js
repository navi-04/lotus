/**
 * Adaptive governor - keeps the picture smooth by trading pixel ratio and frame rate. Pure logic (no DOM, no three), so it is
 * simulated in Node (tools/adaptive-sim.mjs).
 *
 * Why it exists: Ultra is the default on every device, so a weak GPU or a phone starts far above what it can sustain. Two things
 * make a picture feel smooth: frames that arrive at an EVEN rhythm, and enough pixels. A frame rate that wobbles between 30 and
 * 50 looks worse than a steady 30, so the governor works with two dials:
 *
 *  PACE  how many display refreshes each rendered frame lasts (1 = every refresh, 2 = every second one ...). The display's refresh
 *        rate is learned from the rAF timestamps. The animation is slow and soft, so it never renders faster than ~60 fps (a 120 Hz
 *        phone draws every second refresh: the same look for half the work and heat), and it never slows below ~30 fps.
 *  DPR   the pixel ratio, moved in whole steps of a short ladder (every change re-allocates the render targets, which costs a hitch,
 *        so few big moves beat many small ones).
 *
 * The deadline for a frame is  pace x refresh. A window (~0.7 s) is "slow" when more than a quarter of its frames miss that deadline
 * by 30 % or more - the share of late frames is the judder you can see, and unlike a mean it is not hidden by the on-time ones nor
 * inflated by a single long hitch:
 *  - DROP: two slow windows in a row -> step the pixel ratio down in proportion to the overload (warm-up and a capped mean keep
 *    start-up work and one-off hitches from costing resolution).
 *  - EXHAUSTED: still slow at the comfortable floor (1.0x, never blurrier while a slower pace is still available) -> take the next pace
 *    (60 -> 30 fps) and give the resolution back: the deadline just doubled, so the pixels now fit (the controller climbs again).
 *    If the whole descent bought nothing (a CPU-bound stall, a battery-saver cap) the resolution it took is restored right away.
 *  - RECOVER: vsync pins a frame to the deadline, so headroom is never visible; after a calm spell the governor PROBES one step up
 *    in resolution (20 s, doubling to 4 min after a failed probe), and probes one pace faster (90 s, doubling to 24 min). A failed
 *    probe is reverted exactly. Displays that run faster than the deadline simply climb.
 *  - pause()/resume() keep deliberate slow frames (saving a 4K picture) out of the statistics.
 */
const WINDOW_MS = 700;
const WARMUP_S = 1.5;        // ignored at the start: first-use work, not the device's steady speed ...
const WARMUP_FRAMES = 30;    // ... measured in clamped time AND in frames: the first render can hold a single multi-second program-link hitch
const LATE = 1.3;            // a frame is late when it takes longer than this x the deadline (21.7 ms at 60 fps)
const SLOW_SHARE = 0.25;     // a window with more late frames than this is slow: one frame in four misses its deadline
const QUIET_SHARE = 0.03;    // at or under this share the picture is calm enough to probe upwards
const CAP_X = 3;             // a single frame counts for at most this x the deadline in the mean (a 3 s hitch is one late frame, not a verdict)
const FAST = 0.81;           // mean under this x the deadline: the display is faster than the deadline, climb freely
const EPS = 1e-3;
const LEVELS = [0.6, 0.75, 0.85, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];      // the pixel-ratio ladder
const COMFORT = 1;           // the lowest pixel ratio used while a slower pace is still available
const TARGET_FPS = 60;       // never render much faster than this (display refreshes are skipped to get there)
const MIN_FPS = 28;          // never pace slower than this (below it, resolution is the only dial left)
const RAF_RING = 90;
const STD_MS = [6.944, 8.333, 11.111, 13.889, 16.667];        // 144, 120, 90, 72, 60 Hz

const unique = (a) => [...new Set(a.map((x) => +x.toFixed(3)))].sort((x, y) => x - y);

/** a measured refresh interval -> the standard one it matches (60 / 72 / 90 / 120 / 144 Hz), else null */
const snapRefresh = (ms) => STD_MS.find((s) => Math.abs(ms / s - 1) < 0.12) || null;

/**
 * @param {{dprMin: number, getCap: () => number, getDpr: () => number, setDpr: (d: number) => void, pacing?: boolean, refreshHint?: number|null}} o
 *   pacing: false = one frame per refresh always (resolution only)
 *   refreshHint: the refresh interval (ms) measured before the app started heavy work (index.html); a loaded display looks slower than
 *   it is, so the first guess comes from there, and is corrected later from the refreshes the governor skips
 */
export function createAdaptive({ dprMin, getCap, getDpr, setDpr, pacing = true, refreshHint = null, canShed = () => false }) {
  // ---- display refresh and pace --------------------------------------------------------------------------------------------
  const raf = new Float32Array(RAF_RING);
  let rafN = 0, rafAt = 0, rafSince = 0, lastRaf = -1, lastRender = -Infinity;
  let refresh = 1000 / 60, unthrottled = false, pending = null, pendingHits = 0;
  let pace = 1, paceBase = 1, paceMax = 1;
  let paceStable = 0, paceBackoff = 90, paceProbe = null;     // probing one pace faster: paceProbe = {pace0, dpr0, at}

  // ---- resolution ------------------------------------------------------------------------------------------------------------
  const frames = new Float32Array(512);                  // the current window's frame times (ms)
  let n = 0, winT = 0, cooldown = 0, clock = 0, seen = 0;
  let ema = 1000 / 60, fresh = true, paused = false, exhausted = false;
  let streak = 0;                                        // consecutive windows slower than the deadline allows
  let stableT = 0, backoff = 20, probe = null;           // upward probing: probe = {from, at}
  let episode = null;                                    // where the current slowdown began: {dpr0, ema0}
  let hold = 0, holdLen = 120;                           // seconds during which drops/probes are suspended after a "not resolution-bound" verdict

  const deadline = () => pace * refresh;
  // the lowest pixel ratio worth using: sharp (COMFORT) while a slower pace or a lighter scene (canShed) is still on offer, the true floor after
  const floorFor = (p) => (p >= paceMax && !canShed() ? dprMin : Math.min(getCap(), Math.max(dprMin, COMFORT)));
  const ladder = () => unique([...LEVELS.filter((l) => l >= dprMin - EPS && l <= getCap() + EPS), dprMin, getCap()]);
  const levelAtOrBelow = (v, floor) => { const l = ladder().filter((x) => x <= v + EPS && x >= floor - EPS); return l.length ? l[l.length - 1] : floor; };
  const levelUp = (d) => { const l = ladder().filter((x) => x > d + 0.04); return l.length ? l[0] : getCap(); };

  const resetWindow = () => { n = 0; winT = 0; streak = 0; fresh = true; };
  const change = (d, cd) => { setDpr(d); cooldown = cd; fresh = true; streak = 0; };
  function setPace(p, cd = 3) {
    pace = p;
    resetWindow();
    cooldown = Math.max(cooldown, cd);
    episode = null; probe = null; stableT = 0; paceStable = 0;
  }

  function evalRefresh() {
    const a = Array.from(raf.subarray(0, rafN)).sort((x, y) => x - y);
    const p10 = a[Math.floor(a.length * 0.1)];
    let r = refresh, free = false;
    if (p10 < 6) free = true;                                       // frames come faster than any display: an unthrottled benchmark, not a refresh rate
    else {
      const std = STD_MS.find((s) => Math.abs(p10 / s - 1) < 0.12);
      r = std || (p10 > 19 ? 1000 / 60 : p10);                       // can't tell a loaded 60 Hz display from a slow one: assume 60
    }
    const changed = free !== unthrottled || (!free && Math.abs(r / refresh - 1) > 0.08);
    if (changed) {                                                  // two evaluations in a row, so one odd stretch does not re-time the display
      const same = pending && pending.free === free && Math.abs(pending.r / r - 1) < 0.05;
      pendingHits = same ? pendingHits + 1 : 1;
      pending = { free, r };
      if (pendingHits < 2) return;
      unthrottled = free;
      if (!free) refresh = r;
    }
    pending = null; pendingHits = 0;
    applyRefresh();
  }

  /** from the refresh interval: the fastest pace we use (never much above 60 fps) and the slowest (never below ~30 fps) */
  function applyRefresh() {
    const hz = 1000 / refresh;
    if (!pacing || unthrottled) { paceBase = 1; paceMax = 1; }
    else {
      paceBase = Math.max(1, Math.round(hz / TARGET_FPS));          // 60 Hz: every refresh, 90 / 120 / 144 Hz: every second one
      paceMax = Math.max(paceBase, Math.floor(hz / MIN_FPS + 0.05));
    }
    const p = Math.min(paceMax, Math.max(paceBase, pace));
    if (p !== pace) { setPace(p, 1.5); paceProbe = null; }
  }
  if (refreshHint && pacing) { const s = snapRefresh(refreshHint); if (s) refresh = s; }
  applyRefresh();

  /**
   * Call on every requestAnimationFrame with its timestamp (ms). Returns true when this refresh should render a frame.
   * (A device whose pace is 1 renders on every refresh; pace 2 on every second one, and so on.)
   */
  function tick(now) {
    if (lastRaf >= 0) {
      raf[rafAt] = Math.min(now - lastRaf, 200);
      rafAt = (rafAt + 1) % RAF_RING; rafN = Math.min(RAF_RING, rafN + 1);
      if (++rafSince >= 30 && rafN >= 60) { rafSince = 0; evalRefresh(); }
    }
    lastRaf = now;
    if (pace <= 1 || now - lastRender >= (pace - 0.4) * refresh) { lastRender = now; return true; }
    return false;
  }

  /** the window's mean frame time (each frame counted for at most CAP_X x the deadline) and the share of late frames */
  function windowStats(D) {
    let s = 0, late = 0;
    for (let i = 0; i < n; i++) {
      s += Math.min(frames[i], CAP_X * D);
      if (frames[i] > LATE * D) late++;
    }
    return { avg: s / n, late: late / n };
  }

  /** call once per RENDERED frame with the seconds since the previous rendered frame */
  function update(dt) {
    if (paused) return;
    const step = Math.min(dt, 0.1);                       // a multi-second hitch must not use up the warm-up (or a probe's wait) in one frame
    clock += step;
    hold = Math.max(0, hold - step);
    seen++;
    if (clock < WARMUP_S || seen < WARMUP_FRAMES) return;
    const ms = Math.min(dt * 1000, 400);
    if (n < frames.length) frames[n++] = ms;
    winT += ms;
    cooldown = Math.max(0, cooldown - dt);
    if (winT < WINDOW_MS || n < 5) return;
    const D = deadline();
    const { avg, late } = windowStats(D);
    const winSeconds = winT / 1000;
    n = 0; winT = 0;
    ema = fresh ? avg : ema + (avg - ema) * 0.5;
    fresh = false;
    const windowSlow = late > SLOW_SHARE;
    streak = windowSlow ? streak + 1 : 0;
    exhausted = streak >= 2 && pace >= paceMax && getDpr() <= floorFor(pace) + EPS;     // nothing left to give at this floor: the slowest pace, and still late
    if (cooldown > 0) return;

    const dpr = getDpr(), cap = getCap();
    const floor = floorFor(pace);
    const slow = streak >= 1;                                      // this very window missed too many deadlines
    const calm = late <= QUIET_SHARE;
    if (!slow) { episode = null; paceStable += winSeconds; } else paceStable = 0;

    // a probe of a faster pace that is not holding: back to exactly where it was
    if (paceProbe && streak >= 2) {
      const p = paceProbe;
      paceProbe = null; paceBackoff = Math.min(Math.max(paceBackoff * 2, 180), 1440);
      setPace(p.pace0, 3);
      if (Math.abs(getDpr() - p.dpr0) > EPS) change(p.dpr0, 3);
      return;
    }
    if (paceProbe && clock - paceProbe.at > 8) { paceProbe = null; paceBackoff = 90; }   // it held: stay greedy

    if (streak >= 2 && dpr > floor + EPS) {                        // two slow windows in a row: not a hitch
      if (hold > 0) return;
      if (probe) {                                                 // the probe cost too much: back to exactly where it was
        const to = Math.max(floor, Math.min(probe.from, dpr - 0.04));
        probe = null; backoff = Math.min(Math.max(backoff * 2, 60), 480); stableT = 0;
        change(to, 2.5);
        return;
      }
      if (!episode) episode = { dpr0: dpr, ema0: ema };
      const over = ema / D;
      const factor = over > 2.7 ? 0.6 : over > 1.9 ? 0.78 : over > 1.5 ? 0.87 : 0.93;
      stableT = 0;
      change(Math.max(floor, Math.min(dpr - 0.04, levelAtOrBelow(dpr * factor, floor))), over > 1.9 ? 1.2 : 2.5);
      return;
    }

    if (slow) {                                                    // at the floor and still slow
      if (hold > 0 || streak < 2) return;
      const noGain = !!episode && episode.dpr0 > dpr + 0.2 && ema > episode.ema0 * 0.88;     // the descent bought nothing: it was never about pixels
      if (pace < paceMax) {                                        // a slower pace is still on offer: take it, and give the pixels back
        const back = noGain ? Math.min(cap, episode.dpr0) : dpr;
        setPace(pace + 1, 3);
        if (back > getDpr() + EPS) change(back, 3);
        return;
      }
      if (noGain) {                                                // nothing slower exists: restore, and stop trying for a while
        const to = Math.min(cap, episode.dpr0);
        episode = null;
        hold = holdLen; holdLen = Math.min(holdLen * 4, 1920);
        change(to, 2.5);
      }
      return;
    }

    // ---- healthy: look for room to go back up -------------------------------------------------------------------------
    if (pace > paceBase && !paceProbe && !probe && hold <= 0 && calm && paceStable >= paceBackoff) {
      paceProbe = { pace0: pace, dpr0: dpr, at: clock };            // one pace faster, at the comfortable floor, to see whether it holds
      paceStable = 0;
      setPace(pace - 1, 1.6);
      const to = Math.min(dpr, floorFor(pace));
      if (to < dpr - EPS) change(to, 1.6);
      return;
    }
    if (dpr >= cap - EPS) { stableT = 0; probe = null; return; }

    if (ema < FAST * D) {                                          // a display faster than the deadline, with room to spare
      probe = null; stableT = 0;
      change(Math.min(cap, levelUp(dpr)), 4);
      return;
    }
    if (probe && clock - probe.at > 6) { probe = null; backoff = 20; }   // the last probe held: stay greedy
    if (calm && hold <= 0) {
      stableT += winSeconds;
      if (!probe && stableT >= backoff) {
        probe = { from: dpr, at: clock };
        stableT = 0;
        change(Math.min(cap, levelUp(dpr)), 1.6);
      }
    } else stableT = 0;
  }

  return {
    tick,
    update,
    /** keep deliberate slow frames (a 4K capture) out of the statistics */
    pause() { paused = true; },
    resume() { paused = false; n = 0; winT = 0; streak = 0; cooldown = Math.max(cooldown, 3); fresh = true; },
    get ema() { return ema; },
    get paused() { return paused; },
    /** true while the slowest pace at the lowest worthwhile pixel ratio is still late - the only cure left is a lighter scene */
    get exhausted() { return exhausted; },
    /** the display and the pace the governor settled on */
    info() { return { pace, paceBase, paceMax, refreshMs: refresh, hz: 1000 / refresh, fps: 1000 / (pace * refresh), unthrottled, deadlineMs: deadline() }; },
  };
}
