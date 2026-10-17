#!/usr/bin/env node
/**
 * Simulates src/render/adaptive.js against synthetic devices (no browser): node tools/adaptive-sim.mjs
 *
 * Device model: frame cost = fixed + perMPix * megapixels(dpr) (+ optional extra load), then quantized up to whole vsync periods
 * (a 60 Hz display shows 16.7 / 33.3 / 50 ms frames). Every dpr change costs one 150 ms reallocation hitch.
 */
import { createAdaptive } from '../src/render/adaptive.js';

let failed = 0, total = 0;
const check = (name, ok, info = '') => { total++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); };

let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

function simulate({ W = 1280, H = 720, cap = 3, start = cap, floor = 0.75, fixed = 8, perMPix = 15, hz = 60, extra = () => 0, pauseDuring = null }, seconds) {
  let dpr = start, hitch = 0;
  const changes = [];
  let t = 0;
  const ad = createAdaptive({
    dprMin: Math.min(floor, cap), getCap: () => cap, getDpr: () => dpr,
    setDpr: (d) => { changes.push({ t, from: dpr, to: d }); dpr = d; hitch = 150; },
  });
  const frames = [];
  const vsync = 1000 / hz;
  while (t < seconds) {
    const cost = fixed + perMPix * ((W * H * dpr * dpr) / 1e6) + extra(t);
    let ms = cost * (0.96 + 0.08 * rnd());
    if (hitch) { ms += hitch; hitch = 0; }
    ms = Math.max(vsync, Math.ceil(ms / vsync - 1e-9) * vsync);
    const paused = pauseDuring && t >= pauseDuring[0] && t < pauseDuring[1];
    if (pauseDuring && t >= pauseDuring[0] && !ad.paused && t < pauseDuring[1]) ad.pause();
    if (pauseDuring && t >= pauseDuring[1] && ad.paused) ad.resume();
    ad.update(ms / 1000);
    frames.push({ t, ms, dpr });
    t += ms / 1000;
    void paused;
  }
  return { changes, frames, get dpr() { return dpr; }, ad };
}
const slowShare = (frames, from, to) => { const f = frames.filter((x) => x.t >= from && x.t < to); return f.filter((x) => x.ms > 22).length / Math.max(1, f.length); };
const dpr = (r) => r.dpr.toFixed(2);

// 1. a device far too slow for the starting resolution (like the measured 3x 720p case: ~130 ms/frame at DPR 3)
{
  const r = simulate({ cap: 3, fixed: 8, perMPix: 15 }, 300);
  const firstSlow = r.frames.filter((f) => f.t < 10).map((f) => f.dpr);
  check('heavy: starts at 3x and is below 1.3x within 10 s (1.5 s warm-up, then two slow windows per step)', Math.min(...firstSlow) <= 1.3, `min dpr in first 10 s = ${Math.min(...firstSlow).toFixed(2)}`);
  check('heavy: never goes below the floor', r.frames.every((f) => f.dpr >= 0.75 - 1e-9));
  const lateMs = r.frames.filter((f) => f.t > 20).map((f) => f.ms).sort((a, b) => a - b);
  check('heavy: settles on <= 33 ms frames (median)', lateMs[Math.floor(lateMs.length / 2)] <= 34, `median ${lateMs[Math.floor(lateMs.length / 2)].toFixed(1)} ms, final dpr ${dpr(r)}`);
  const probesAfter = r.changes.filter((c) => c.t > 10);
  check('heavy: after settling, only a few probe attempts in 5 minutes (backing off)', probesAfter.length <= 12, `${probesAfter.length} changes`);
  check('heavy: slow frames after the first 10 s stay a small share', slowShare(r.frames, 10, 300) < 0.08, `${(slowShare(r.frames, 10, 300) * 100).toFixed(1)} %`);
}

// 2. a fast device on a 60 Hz display: nothing should change
{
  const r = simulate({ cap: 2, fixed: 2, perMPix: 2 }, 300);
  check('light 60 Hz: no changes at all', r.changes.length === 0, `${r.changes.length} changes, dpr ${dpr(r)}`);
}

// 2b. start-up work and hitches must not cost resolution (a real trace: a 97 ms first window dropped medium straight to its floor)
{
  const startup = simulate({ cap: 2, fixed: 2, perMPix: 2, extra: (t) => (t < 1.4 ? 100 : 0) }, 120);
  check('start-up work inside the warm-up is ignored', startup.changes.length === 0, `${startup.changes.length} changes`);
  const burst = simulate({ cap: 2, fixed: 2, perMPix: 2, extra: (t) => (t > 20 && t < 20.4 ? 120 : 0) }, 120);
  check('a burst of slow frames inside one window is trimmed away', burst.changes.length === 0, `${burst.changes.length} changes`);
  const spell = simulate({ cap: 2, fixed: 2, perMPix: 2, extra: (t) => (t > 20 && t < 20.7 ? 40 : 0) }, 120);
  check('a single slow window is not enough to drop', spell.changes.length === 0, `${spell.changes.length} changes`);
}

// 3. a transient stall, then recovery to the full resolution on a 60 Hz display (the audit's "never recovers" case)
{
  const r = simulate({ cap: 2, fixed: 2, perMPix: 2, extra: (t) => (t > 10 && t < 14 ? 45 : 0) }, 400);
  check('transient: drops during the stall', r.changes.some((c) => c.t > 10 && c.t < 20 && c.to < c.from));
  check('transient: recovers to the full resolution afterwards', Math.abs(r.dpr - 2) < 1e-6, `final dpr ${dpr(r)}`);
  const recoveredAt = (r.frames.find((f) => f.t > 20 && f.dpr >= 2 - 1e-9) || {}).t;
  check('transient: ... within ~4 minutes', recoveredAt != null && recoveredAt < 260, `recovered at ${recoveredAt && recoveredAt.toFixed(0)} s`);
}

// 4. a borderline device: full res misses vsync, a notch lower fits
{
  const r = simulate({ cap: 2, fixed: 6, perMPix: 5.8 }, 600);
  const late = r.frames.filter((f) => f.t > 60);
  const bad = late.filter((f) => f.ms > 22).length / late.length;
  check('borderline: settles near 1.3-1.5x', r.dpr >= 1.2 && r.dpr <= 1.6, `dpr ${dpr(r)}`);
  check('borderline: failed probes cost < 4 % of frames over 10 minutes', bad < 0.04, `${(bad * 100).toFixed(2)} %`);
  const ups = r.changes.filter((c) => c.t > 30 && c.to > c.from).length;
  check('borderline: probe attempts back off (<= 8 in 10 minutes)', ups <= 8, `${ups} upward steps`);
}

// 5. saving a 4K picture: slow frames must not move the resolution
{
  const r = simulate({ cap: 1.5, start: 1.5, fixed: 2, perMPix: 2, extra: (t) => (t > 20 && t < 26 ? 300 : 0), pauseDuring: [20, 26] }, 120);
  check('capture: paused controller keeps the resolution', r.changes.length === 0, `${r.changes.length} changes`);
  const r2 = simulate({ cap: 1.5, start: 1.5, fixed: 2, perMPix: 2, extra: (t) => (t > 20 && t < 26 ? 300 : 0) }, 40);
  check('(control) without pausing, the same stall does collapse the resolution', r2.changes.some((c) => c.to < c.from), `${r2.changes.length} changes`);
}

// 6. displays faster than 60 Hz climb on their own
{
  const r = simulate({ cap: 3, start: 1, fixed: 2, perMPix: 0.4, hz: 120 }, 200);
  check('120 Hz: climbs from 1x to 3x on its own', Math.abs(r.dpr - 3) < 1e-6, `dpr ${dpr(r)}`);
  const r2 = simulate({ cap: 3, start: 1, fixed: 2, perMPix: 2, hz: 120 }, 400);
  const late2 = r2.frames.filter((f) => f.t > 150);
  const mean2 = late2.reduce((a, f) => a + f.ms, 0) / late2.length;       // borderline frames alternate 16.7 / 25 ms: judge the average, as the controller does
  check('120 Hz but only a 60 fps-class GPU: climbs while it can, average frame stays under the 22 ms drop threshold', r2.dpr > 1.8 && r2.dpr <= 3 && mean2 < 22.5, `final dpr ${dpr(r2)}, mean frame after 150 s: ${mean2.toFixed(1)} ms`);
}

// 7. a 30 Hz refresh cap (battery saver): slow at any resolution, so resolution must be restored
{
  const r = simulate({ cap: 3, fixed: 2, perMPix: 2, hz: 30 }, 200);
  check('30 Hz cap: resolution is restored to the full 3x', Math.abs(r.dpr - 3) < 1e-6 || r.frames.filter((f) => f.t > 60).every((f) => f.dpr >= 2.9), `final dpr ${dpr(r)}`);
  const lowTime = r.frames.filter((f) => f.dpr < 2.9).length / r.frames.length;
  check('30 Hz cap: the descent-and-restore detour is brief (< 15 % of frames in 200 s)', lowTime < 0.15, `${(lowTime * 100).toFixed(1)} %`);
}

// 8. a weak GPU on a 1x 1080p display (floor below 1): descends to the floor and stays, does not undo a real gain
{
  const r = simulate({ W: 1920, H: 1080, cap: 1, fixed: 8, perMPix: 15, floor: 0.75 }, 200);
  check('1080p@1x weak GPU: goes to the floor and stays (a real gain: 50 -> 33 ms)', r.frames.filter((f) => f.t > 20).every((f) => f.dpr <= 0.81), `final dpr ${dpr(r)}`);
}

// 9. a very fast phone: starts at 2x with a cap of 3 and climbs back
{
  const r = simulate({ cap: 3, start: 2, fixed: 2, perMPix: 1.2 }, 400);
  check('fast 60 Hz phone: starts at 2x and probes its way up to 3x', Math.abs(r.dpr - 3) < 1e-6, `final dpr ${dpr(r)}`);
}

console.log(JSON.stringify({ total, failed }));
process.exit(failed ? 1 : 0);
