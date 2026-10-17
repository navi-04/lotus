/**
 * Adaptive resolution - trades pixel ratio for frame rate. Pure logic (no DOM, no three), so it is simulated in Node
 * (tools/adaptive-sim.mjs).
 *
 * Why it exists: Ultra is the default on every device, so a weak GPU or a phone starts far above what it can sustain. Frame time
 * scales roughly with the pixel count, therefore:
 *  - DROP: measure a ~0.7 s window (ignoring its single worst frame: GC / program-link hitches) and, when it is slower than
 *    ~45 fps, jump proportionally to the overload rather than creeping (a phone at 3x settles in seconds).
 *  - NOT RESOLUTION-BOUND: a 30 Hz refresh cap (battery saver) or a CPU-bound stall is slow at ANY resolution. If the whole
 *    descent to the floor bought nothing (judged over the descent, because vsync quantizes frame times into 16.7 ms steps and
 *    can hide a real gain until the next step), the resolution is restored and drops are suspended (2 min, then 8, then 32).
 *  - RECOVER: a 60 Hz display can never show headroom (vsync pins a frame at ~16.7 ms), so after ~20 s of calm it probes one small
 *    step up; a failed probe is reverted exactly and the wait before the next one doubles (20 s .. 4 min). Displays faster than
 *    60 Hz (frames < 13.5 ms) simply climb.
 *  - pause()/resume() keep deliberate slow frames (saving a 4K picture) out of the statistics.
 */
const WINDOW_MS = 700;
const DROP_MS = 22;          // slower than ~45 fps -> reduce
const QUIET_MS = 19.5;       // at (or under) a 60 Hz vsync -> may probe upwards
const FAST_MS = 13.5;        // faster than 60 Hz -> climb freely
const EPS = 1e-3;

/**
 * @param {{dprMin: number, getCap: () => number, getDpr: () => number, setDpr: (d: number) => void}} o
 */
export function createAdaptive({ dprMin, getCap, getDpr, setDpr }) {
  let seen = 0, winT = 0, winN = 0, winMax = 0, cooldown = 0, clock = 0;
  let ema = 16.7, fresh = true, paused = false;
  let stableT = 0, backoff = 20, probe = null;          // upward probing: probe = {from, at}
  let episode = null;                                    // where the current slowdown began: {dpr0, ema0}
  let hold = 0, holdLen = 120;                           // seconds during which drops/probes are suspended after a "not resolution-bound" verdict

  const change = (d, cd) => { setDpr(d); cooldown = cd; fresh = true; };

  function update(dt) {
    if (paused) return;
    clock += dt;
    hold = Math.max(0, hold - dt);
    if (++seen <= 6) return;                                       // first frames: lazy uploads / program links
    const ms = Math.min(dt * 1000, 400);
    winT += ms; winN++; winMax = Math.max(winMax, ms);
    cooldown = Math.max(0, cooldown - dt);
    if (winT < WINDOW_MS || winN < 5) return;
    const avg = (winT - winMax) / (winN - 1);
    const winSeconds = winT / 1000;
    winT = 0; winN = 0; winMax = 0;
    ema = fresh ? avg : ema + (avg - ema) * 0.5;
    fresh = false;
    if (cooldown > 0) return;

    const dpr = getDpr(), cap = getCap();
    const slow = ema > DROP_MS;
    if (!slow) episode = null;                                     // healthy again: that slowdown is over

    if (slow && dpr > dprMin + EPS) {
      if (hold > 0) return;
      if (probe) {                                                 // the probe cost too much: back to exactly where it was
        const to = Math.max(dprMin, Math.min(probe.from, dpr - 0.01));
        probe = null; backoff = Math.min(backoff * 2, 240); stableT = 0;
        change(to, 2.5);
        return;
      }
      if (!episode) episode = { dpr0: dpr, ema0: ema };
      const over = ema / 16.7;
      const to = Math.max(dprMin, over > 2.7 ? dpr * 0.6 : over > 1.9 ? dpr * 0.78 : dpr - 0.15);
      stableT = 0;
      change(to, over > 1.9 ? 1.2 : 2.5);
      return;
    }

    if (slow) {                                                    // already at the floor and still slow: was it ever about pixels?
      if (episode && episode.dpr0 > dpr + 0.2 && ema > episode.ema0 * 0.88) {
        const to = Math.min(cap, episode.dpr0);
        episode = null;
        hold = holdLen; holdLen = Math.min(holdLen * 4, 1920);
        change(to, 2.5);
      }
      return;
    }

    if (dpr >= cap - EPS) { stableT = 0; probe = null; return; }

    if (ema < FAST_MS) {                                           // a display faster than 60 Hz with room to spare
      probe = null; stableT = 0;
      change(Math.min(cap, dpr + 0.1), 4);
      return;
    }
    if (probe && clock - probe.at > 6) { probe = null; backoff = 20; }   // the last probe held: stay greedy
    if (ema < QUIET_MS && hold <= 0) {
      stableT += winSeconds;
      if (!probe && stableT >= backoff) {
        probe = { from: dpr, at: clock };
        stableT = 0;
        change(Math.min(cap, dpr + 0.15), 1.6);
      }
    } else stableT = 0;
  }

  return {
    update,
    /** keep deliberate slow frames (a 4K capture) out of the statistics */
    pause() { paused = true; },
    resume() { paused = false; winT = 0; winN = 0; winMax = 0; cooldown = Math.max(cooldown, 3); fresh = true; },
    get ema() { return ema; },
    get paused() { return paused; },
  };
}
