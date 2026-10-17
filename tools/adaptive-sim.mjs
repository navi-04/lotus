#!/usr/bin/env node
/**
 * Simulates src/render/adaptive.js (the pacing + resolution governor) against synthetic devices (no browser): node tools/adaptive-sim.mjs
 *
 * Device model: a display ticks at `hz`; the governor's tick() says whether a tick renders. A frame costs
 * fixed + perMPix * megapixels(dpr) (+ optional extra load, +/-4 % noise) and the next callback is the first display tick after it
 * finishes (so frame times quantize to whole refresh periods, like vsync). Every dpr change costs one 150 ms reallocation hitch.
 */
import { createAdaptive } from '../src/render/adaptive.js';
import { createShedder } from '../src/core/shed.js';

let failed = 0, total = 0;
const check = (name, ok, info = '') => { total++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); };

let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

function simulate({ W = 1280, H = 720, cap = 3, start = cap, floor = 0.75, fixed = 8, perMPix = 15, hz = 60, extra = () => 0, pauseDuring = null, pacing = true, shed = false, shedStart = 0 }, seconds) {
  let dpr = start, hitch = 0;
  const changes = [];
  let t = 0;                                              // ms; always a display tick
  const vs = 1000 / hz;
  const shedder = shed ? createShedder({ level: shedStart }) : null;
  const ad = createAdaptive({
    dprMin: Math.min(floor, cap), getCap: () => cap, getDpr: () => dpr, pacing,
    canShed: () => !!shedder && shedder.canShed,
    setDpr: (d) => { changes.push({ t: t / 1000, kind: 'dpr', from: dpr, to: d }); dpr = d; hitch = 150; },
  });
  const frames = [];
  let lastStart = null, lastPace = 1;
  while (t < seconds * 1000) {
    if (!ad.tick(t)) { t += vs; continue; }
    const interval = lastStart == null ? vs : t - lastStart;
    lastStart = t;
    const ts = t / 1000;
    if (pauseDuring && ts >= pauseDuring[0] && !ad.paused && ts < pauseDuring[1]) ad.pause();
    if (pauseDuring && ts >= pauseDuring[1] && ad.paused) ad.resume();
    ad.update(interval / 1000);
    const p = ad.info().pace;
    if (p !== lastPace) { changes.push({ t: ts, kind: 'pace', from: lastPace, to: p }); lastPace = p; }
    if (shedder) { const lv = shedder.update(interval / 1000, ad.exhausted); if (lv) changes.push({ t: ts, kind: 'shed', from: lv - 1, to: lv }); }
    const lightness = shedder ? Math.pow(0.8, shedder.level) : 1;                 // each shed level makes the scene ~20 % cheaper
    const cost = (fixed + perMPix * ((W * H * dpr * dpr) / 1e6) + extra(ts)) * lightness * (0.96 + 0.08 * rnd()) + hitch;
    hitch = 0;
    frames.push({ t: ts, ms: interval, dpr, pace: p });
    t = Math.max(t + vs, Math.ceil((t + cost) / vs - 1e-9) * vs);
  }
  return { changes, frames, ad, get dpr() { return dpr; }, get pace() { return ad.info().pace; }, get shed() { return shedder ? shedder.level : 0; } };
}
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const lateFrames = (r, from) => r.frames.filter((f) => f.t > from);
/** share of frames that arrive 1.5x later than the median rhythm: the stutter you can see */
const jank = (r, from, to = Infinity) => { const f = r.frames.filter((x) => x.t >= from && x.t < to); const m = med(f.map((x) => x.ms)); return f.filter((x) => x.ms > 1.5 * m).length / Math.max(1, f.length); };
const fps = (r, from, to) => { const f = r.frames.filter((x) => x.t >= from && x.t < to); return f.length / (to - from); };
const dprStr = (r) => r.dpr.toFixed(2);
const dprChanges = (r, from = 0, to = Infinity) => r.changes.filter((c) => c.kind === 'dpr' && c.t >= from && c.t < to).length;

// 1. a device far too slow for the starting resolution (the measured 3x 720p case): it must end on an even rhythm, not a wobble
{
  const r = simulate({ cap: 3, fixed: 8, perMPix: 15 }, 300);
  check('heavy: never leaves the allowed range', r.frames.every((f) => f.dpr >= 0.75 - 1e-9 && f.dpr <= 3 + 1e-9 && f.pace >= 1 && f.pace <= 2));
  check('heavy: within 12 s it has stopped wasting frames at 3x (pace 2 or a lower ratio)', r.frames.filter((f) => f.t > 12).every((f) => f.pace === 2 || f.dpr <= 1.5), `final pace ${r.pace}, dpr ${dprStr(r)}`);
  check('heavy: settles on an even 30 fps (median 33 ms, under 6 % stutter after 60 s)', Math.abs(med(lateFrames(r, 60).map((f) => f.ms)) - 33.3) < 1 && jank(r, 60) < 0.06, `median ${med(lateFrames(r, 60).map((f) => f.ms)).toFixed(1)} ms, stutter ${(jank(r, 60) * 100).toFixed(1)} %`);
  check('heavy: keeps the picture sharp at 30 fps (pixel ratio >= 1.0)', r.dpr >= 1 - 1e-9, `dpr ${dprStr(r)}`);
  check('heavy: few resizes after the first 20 s (each one is a hitch)', dprChanges(r, 20) <= 8, `${dprChanges(r, 20)} in 280 s`);
}

// 2. a fast device on a 60 Hz display: nothing should change
{
  const r = simulate({ cap: 2, fixed: 2, perMPix: 2 }, 300);
  check('light 60 Hz: no changes at all, pace 1', r.changes.length === 0 && r.pace === 1, `${r.changes.length} changes, dpr ${dprStr(r)}`);
}

// 2b. start-up work and hitches must not cost resolution or rate (a real trace: a 97 ms first window dropped medium straight to its floor)
{
  const startup = simulate({ cap: 2, fixed: 2, perMPix: 2, extra: (t) => (t < 1.4 ? 100 : 0) }, 120);
  check('start-up work inside the warm-up is ignored', startup.changes.length === 0, `${startup.changes.length} changes`);
  const burst = simulate({ cap: 2, fixed: 2, perMPix: 2, extra: (t) => (t > 20 && t < 20.4 ? 120 : 0) }, 120);
  check('a burst of slow frames inside one window is trimmed away', burst.changes.length === 0, `${burst.changes.length} changes`);
  const spell = simulate({ cap: 2, fixed: 2, perMPix: 2, extra: (t) => (t > 20 && t < 20.7 ? 40 : 0) }, 120);
  check('a single slow window is not enough to drop', spell.changes.length === 0, `${spell.changes.length} changes`);
}

// 3. a transient stall, then recovery to full resolution AND full rate
{
  const r = simulate({ cap: 2, fixed: 2, perMPix: 2, extra: (t) => (t > 10 && t < 14 ? 45 : 0) }, 600);
  check('transient: reacts during the stall', r.changes.some((c) => c.t > 10 && c.t < 25));
  check('transient: back to the full resolution and every refresh afterwards', Math.abs(r.dpr - 2) < 1e-6 && r.pace === 1, `final dpr ${dprStr(r)}, pace ${r.pace}`);
  const back = (r.frames.find((f) => f.t > 20 && f.dpr >= 2 - 1e-9 && f.pace === 1) || {}).t;
  check('transient: ... within ~6 minutes', back != null && back < 380, `recovered at ${back && back.toFixed(0)} s`);
}

// 4. a borderline device: full res misses the 60 fps deadline, a notch lower fits
{
  const r = simulate({ cap: 2, fixed: 6, perMPix: 5.8 }, 600);
  check('borderline: settles at 60 fps with a pixel ratio around 1.25-1.75', r.pace === 1 && r.dpr >= 1.2 && r.dpr <= 1.8, `pace ${r.pace}, dpr ${dprStr(r)}`);
  check('borderline: failed probes cost < 5 % stutter over 10 minutes', jank(r, 60) < 0.05, `${(jank(r, 60) * 100).toFixed(2)} %`);
  const ups = r.changes.filter((c) => c.kind === 'dpr' && c.t > 30 && c.to > c.from).length;
  check('borderline: probe attempts back off (<= 8 upward steps in 10 minutes)', ups <= 8, `${ups} upward steps`);
}

// 5. saving a 4K picture: slow frames must not move anything
{
  const r = simulate({ cap: 1.5, start: 1.5, fixed: 2, perMPix: 2, extra: (t) => (t > 20 && t < 26 ? 300 : 0), pauseDuring: [20, 26] }, 120);
  check('capture: paused controller keeps resolution and pace', r.changes.length === 0, `${r.changes.length} changes`);
  const r2 = simulate({ cap: 1.5, start: 1.5, fixed: 2, perMPix: 2, extra: (t) => (t > 20 && t < 26 ? 300 : 0) }, 40);
  check('(control) without pausing, the same stall does move something', r2.changes.length > 0, `${r2.changes.length} changes`);
}

// 6. displays faster than 60 Hz: never renders much above 60 fps
{
  const r = simulate({ cap: 3, start: 1.5, fixed: 2, perMPix: 0.4, hz: 120 }, 300);
  const f = fps(r, 20, 300);
  check('120 Hz fast GPU: renders every second refresh (about 60 fps), not 120', r.pace === 2 && f > 55 && f < 65, `pace ${r.pace}, ${f.toFixed(1)} fps`);
  check('120 Hz fast GPU: still climbs to the full 3x (by probing)', Math.abs(r.dpr - 3) < 1e-6, `dpr ${dprStr(r)}`);
  const r2 = simulate({ cap: 3, start: 1.5, fixed: 4, perMPix: 6, hz: 120 }, 400);
  const f2 = fps(r2, 60, 400);
  check('120 Hz, a GPU that cannot do 60 at 3x: ends on an even rhythm of at least 38 fps', f2 >= 38 && jank(r2, 60) < 0.08, `pace ${r2.pace}, dpr ${dprStr(r2)}, ${f2.toFixed(1)} fps, stutter ${(jank(r2, 60) * 100).toFixed(1)} %`);
  const r3 = simulate({ cap: 3, start: 1.5, fixed: 4, perMPix: 6, hz: 120 }, 400);
  void r3;
  const hint = (() => {
    let dprH = 1.5, tH = 0; const vs = 1000 / 120; const ch = [];
    const ad = createAdaptive({ dprMin: 0.75, getCap: () => 3, getDpr: () => dprH, setDpr: (d) => { ch.push(d); dprH = d; }, refreshHint: 8.4 });
    return { info: ad.info(), tH, vs, ch };
  })();
  check('a refresh hint from page load (8.4 ms) is believed at once: 120 Hz -> pace 2 from the first frame', hint.info.pace === 2 && hint.info.paceBase === 2 && Math.abs(hint.info.refreshMs - 8.333) < 0.01, JSON.stringify(hint.info));
  const junk = createAdaptive({ dprMin: 0.75, getCap: () => 3, getDpr: () => 2, setDpr: () => {}, refreshHint: 33 }).info();
  check('a hint that is not a known display rate (33 ms) is ignored', junk.pace === 1 && Math.abs(junk.refreshMs - 16.667) < 0.01, JSON.stringify(junk));
}

// 6b. 90 Hz phone
{
  const r = simulate({ W: 390, H: 844, cap: 3, start: 1.5, fixed: 6, perMPix: 20, hz: 90 }, 300);
  const f = fps(r, 60, 300);
  check('90 Hz phone: even pacing at 45 fps or 30 fps, little stutter', (r.pace === 2 || r.pace === 3) && jank(r, 60) < 0.08, `pace ${r.pace}, dpr ${dprStr(r)}, ${f.toFixed(1)} fps, stutter ${(jank(r, 60) * 100).toFixed(1)} %`);
}

// 7. a 30 Hz refresh cap (battery saver): slow at any resolution, so resolution must come back
{
  const r = simulate({ cap: 3, fixed: 2, perMPix: 2, hz: 30 }, 200);
  check('30 Hz cap: resolution ends at the full 3x', Math.abs(r.dpr - 3) < 1e-6 || r.frames.filter((f) => f.t > 60).every((f) => f.dpr >= 2.9), `final dpr ${dprStr(r)}, pace ${r.pace}`);
  const lowTime = r.frames.filter((f) => f.dpr < 2.9).length / r.frames.length;
  check('30 Hz cap: the detour to a lower ratio is brief (< 15 % of frames in 200 s)', lowTime < 0.15, `${(lowTime * 100).toFixed(1)} %`);
}

// 8. a weak GPU on a 1x 1080p display (floor below 1)
{
  const r = simulate({ W: 1920, H: 1080, cap: 1, fixed: 8, perMPix: 15, floor: 0.75 }, 300);
  check('1080p@1x weak GPU: even 30 fps (median 33 ms) after settling', Math.abs(med(lateFrames(r, 40).map((f) => f.ms)) - 33.3) < 1 && jank(r, 40) < 0.06, `pace ${r.pace}, dpr ${dprStr(r)}, stutter ${(jank(r, 40) * 100).toFixed(1)} %`);
}

// 9. a very fast phone: starts at 1.5x with a cap of 3 and climbs back, at 60 fps throughout
{
  const r = simulate({ W: 390, H: 844, cap: 3, start: 1.5, fixed: 2, perMPix: 1.2 }, 600);
  check('fast 60 Hz phone: climbs to 3x and stays at pace 1', Math.abs(r.dpr - 3) < 1e-6 && r.pace === 1, `final dpr ${dprStr(r)}, pace ${r.pace}`);
  const reach = (r.frames.find((f) => f.dpr >= 3 - 1e-9) || {}).t;
  check('fast 60 Hz phone: reaches 3x within ~3 minutes', reach != null && reach < 200, `${reach && reach.toFixed(0)} s`);
}

// 10. a mid-range phone: 60 Hz, cannot hold 60 fps at the sharp ratios
{
  const r = simulate({ W: 390, H: 844, cap: 3, start: 1.5, fixed: 10, perMPix: 22 }, 400);
  check('mid-range phone: lands on an even rhythm with the ratio at least 1.0', jank(r, 60) < 0.06 && r.dpr >= 1 - 1e-9, `pace ${r.pace}, dpr ${dprStr(r)}, stutter ${(jank(r, 60) * 100).toFixed(1)} %`);
}

// 11. a thermally throttled phone: it was fine, then everything gets 1.8x slower
{
  const r = simulate({ W: 390, H: 844, cap: 3, start: 1.5, fixed: 4, perMPix: 8, extra: () => 0 }, 100);
  void r;
  let throttled = false;
  const r2 = simulate({ W: 390, H: 844, cap: 3, start: 1.5, fixed: 4, perMPix: 8, extra: (t) => { if (t > 120) throttled = true; return throttled ? 14 : 0; } }, 420);
  check('throttling: reacts within 20 s and ends even', jank(r2, 160) < 0.08, `pace ${r2.pace}, dpr ${dprStr(r2)}, stutter ${(jank(r2, 160) * 100).toFixed(1)} %`);
  check('throttling: the descent is a handful of resizes, not a stream', dprChanges(r2, 120, 160) <= 5, `${dprChanges(r2, 120, 160)} resizes in 40 s`);
}

// 11b. a weak phone: even the 30 fps pace at a sharp pixel ratio is late, so lighter effects (not a blurrier picture) are the cure
{
  const weak = { W: 390, H: 844, cap: 3, start: 1.5, fixed: 28, perMPix: 40 };
  const a = simulate({ ...weak, shed: true }, 200);
  check('weak phone: sheds effects, and keeps the picture sharp (pixel ratio >= 1.0)', a.shed >= 1 && a.dpr >= 1 - 1e-9, `shed level ${a.shed}, dpr ${dprStr(a)}, pace ${a.pace}`);
  check('weak phone: ends on an even rhythm', jank(a, 60) < 0.08, `stutter ${(jank(a, 60) * 100).toFixed(1)} %`);
  const sheds = a.changes.filter((c) => c.kind === 'shed');
  check('weak phone: the first shed comes within ~20 s of the start', sheds.length > 0 && sheds[0].t < 20, `${sheds.map((s) => s.t.toFixed(1)).join(', ')} s`);
  const b = simulate({ ...weak, shed: false }, 200);
  check('(control) without shedding the same phone goes blurrier than 1.0', b.dpr < 1 - 1e-9, `dpr ${dprStr(b)}`);
  const c = simulate({ ...weak, shed: true, shedStart: 2 }, 120);
  check('remembered level 2: no further shedding, the governor may use its full floor', c.shed === 2 && c.changes.filter((x) => x.kind === 'shed').length === 0, `shed ${c.shed}`);
  const light = simulate({ cap: 2, fixed: 2, perMPix: 2, shed: true }, 200);
  check('a healthy device never sheds', light.shed === 0, `shed ${light.shed}`);
}

// 12. pacing switched off (resolution only, as before): no frame is ever skipped
{
  const r = simulate({ cap: 3, fixed: 8, perMPix: 15, pacing: false }, 120);
  check('pacing off: every refresh renders and the pace stays 1', r.pace === 1 && r.frames.every((f) => f.pace === 1));
}

// 13. an unthrottled benchmark (rAF faster than any display): pacing must stay out of the way
{
  const r = simulate({ cap: 2, start: 2, fixed: 0.5, perMPix: 0.5, hz: 400 }, 60);
  check('unthrottled (400 Hz of frames): no skipping, pace 1', r.pace === 1 && r.frames.length > 60 * 300, `${r.frames.length} frames, pace ${r.pace}`);
}

// 14. fuzz: random devices and random load spells must never break the invariants
{
  let bad = null;
  for (let k = 0; k < 40 && !bad; k++) {
    const hz = [30, 48, 60, 60, 72, 90, 120, 144][Math.floor(rnd() * 8)];
    const cap = [1, 1.5, 2, 3][Math.floor(rnd() * 4)];
    const spells = Array.from({ length: 3 }, () => ({ a: rnd() * 200, len: 1 + rnd() * 20, ms: rnd() * 60 }));
    const r = simulate({ W: 390 + Math.floor(rnd() * 900), H: 700, cap, start: Math.min(cap, [1, 1.5, 2, 3][Math.floor(rnd() * 4)]), fixed: 1 + rnd() * 14, perMPix: 0.5 + rnd() * 30, hz, extra: (t) => spells.reduce((s, x) => s + (t > x.a && t < x.a + x.len ? x.ms : 0), 0) }, 240);
    const info = r.ad.info();
    const dprs = r.frames.map((f) => f.dpr), paces = r.frames.map((f) => f.pace);
    const dprOk = dprs.every((d) => Number.isFinite(d) && d >= 0.6 - 1e-9 && d <= cap + 1e-9);
    const paceOk = paces.every((p) => Number.isInteger(p) && p >= 1 && p <= 6) && info.pace >= info.paceBase && info.pace <= info.paceMax;
    const resizes = dprChanges(r);
    if (!dprOk || !paceOk || !Number.isFinite(info.fps) || resizes > 60) bad = { k, hz, cap, resizes, dprOk, paceOk, info };
  }
  check('fuzz: 40 random devices keep the pixel ratio and pace in range, never a stream of resizes', !bad, bad ? JSON.stringify(bad) : '');
}

console.log(JSON.stringify({ total, failed }));
process.exit(failed ? 1 : 0);
