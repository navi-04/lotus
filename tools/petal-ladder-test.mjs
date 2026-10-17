#!/usr/bin/env node
/**
 * Unit checks for the petal ladder (no browser): node tools/petal-ladder-test.mjs
 * The probe and the builders are fakes, so every path - first rung fine, a failing rung, a builder that throws, nothing working - is
 * checked deterministically, along with the one-week memory of the rung that worked.
 */
import { RUNGS, RUNG_KEY, RUNG_TTL_MS, MIN_PIXELS, parseForced, readStart, writeRung, settleLadder } from '../src/lotus/petalLadder.js';

let failed = 0, total = 0;
const check = (name, ok, info = '') => { total++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); };

const NOW = 1_700_000_000_000;
const store = (init = {}) => { const m = new Map(Object.entries(init)); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { if (v == null) m.delete(k); else m.set(k, String(v)); return true; }, m }; };

// ---- the ladder itself -----------------------------------------------------------------------------------------------------
check('the ladder runs tex > inst > instlite > cpu', RUNGS.join(',') === 'tex,inst,instlite,cpu');

/** a fake GPU: `pixels` maps a rung to what the probe sees; a rung missing from it throws when built */
const run = (pixels, opt = {}) => {
  const built = [];
  const p = settleLadder({ ...opt, build: (id) => { built.push(id); if (!(id in pixels)) throw new Error(`cannot build ${id}`); }, probe: (id) => pixels[id] });
  return p.then((r) => ({ ...r, built }));
};

{
  const r = await run({ tex: 900 });
  check('top rung draws: it is kept and nothing else is built', r.ok && r.id === 'tex' && r.built.join() === 'tex' && r.tried.length === 1, JSON.stringify(r.tried));
}
{
  const r = await run({ tex: 0, inst: 750 });
  check('top rung draws nothing: the next one is tried and kept', r.ok && r.id === 'inst' && r.built.join() === 'tex,inst', JSON.stringify(r.tried));
  check('every attempt is reported with its pixel count', r.tried[0].px === 0 && !r.tried[0].ok && r.tried[1].px === 750 && r.tried[1].ok);
}
{
  const r = await run({ tex: 0, inst: 3, instlite: 600 });
  check('a rung with only a few stray pixels still fails', r.id === 'instlite' && r.tried.map((t) => t.ok).join() === 'false,false,true', JSON.stringify(r.tried));
}
{
  const r = await run({ tex: 0, inst: 0, instlite: 0, cpu: 500 });
  check('only the last resort works: it is reached and kept', r.ok && r.id === 'cpu' && r.built.join() === 'tex,inst,instlite,cpu');
}
{
  const r = await run({ tex: 0, inst: 0, instlite: 0, cpu: 0 });
  check('nothing works: ok is false, no rung is named, all four were tried', !r.ok && r.id === null && r.tried.length === 4);
}
{
  const r = await run({ tex: 0, instlite: 400 });                    // inst cannot even be built
  check('a rung that throws is recorded and skipped', r.ok && r.id === 'instlite' && r.tried[1].err === 'cannot build inst' && r.tried[1].px === 0 && !r.tried[1].ok, JSON.stringify(r.tried[1]));
}
{
  const r = await settleLadder({ build: () => {}, probe: (id) => { if (id === 'tex') throw new Error('probe blew up'); return 300; } });
  check('a probe that throws counts as a failed rung, not a crash', r.ok && r.id === 'inst' && r.tried[0].err === 'probe blew up');
}
{
  const r = await run({ tex: 900, inst: 900, instlite: 0, cpu: 900 }, { start: 2 });
  check('starting at a lower rung skips the ones above it', r.built.join() === 'instlite,cpu' && r.id === 'cpu', r.built.join());
}
{
  const r = await run({ tex: 900 }, { start: -5 });
  check('a negative start is treated as the top', r.id === 'tex');
}
{
  const r = await run({ tex: 900 }, { start: 9 });
  check('a start past the end tries nothing and says so', !r.ok && r.id === null && r.tried.length === 0);
}
{
  const edge = await run({ tex: MIN_PIXELS });
  const under = await run({ tex: MIN_PIXELS - 1, inst: 500 });
  check(`the threshold is ${MIN_PIXELS} pixels: that many passes, one fewer fails`, edge.id === 'tex' && under.id === 'inst');
}
{
  const order = [];
  await settleLadder({ build: async (id) => { order.push(`b:${id}`); await new Promise((r) => setTimeout(r, 2)); }, probe: async (id) => { order.push(`p:${id}`); return id === 'inst' ? 100 : 0; } });
  check('async builders and probes are awaited in order (build, probe, build, probe)', order.join() === 'b:tex,p:tex,b:inst,p:inst', order.join());
}

// ---- ?petals= ----------------------------------------------------------------------------------------------------------------------
check('?petals= accepts every rung, any case, padded', RUNGS.every((id) => parseForced(id) === id) && parseForced(' INST ') === 'inst');
check('?petals=auto, junk, empty and missing all mean "decide yourself"', [parseForced('auto'), parseForced('turbo'), parseForced(''), parseForced(null), parseForced(undefined), parseForced('__proto__')].every((v) => v === null));

// ---- the week-long memory --------------------------------------------------------------------------------------------------------
check('nothing stored: start at the top', readStart(store(), NOW) === 0);
check('a fresh note for inst starts there', readStart(store({ [RUNG_KEY]: `inst@${NOW - 1000}` }), NOW) === 1);
check('a fresh note for cpu starts at the bottom', readStart(store({ [RUNG_KEY]: `cpu@${NOW}` }), NOW) === 3);
check('a note just under a week old still applies', readStart(store({ [RUNG_KEY]: `instlite@${NOW - RUNG_TTL_MS + 1000}` }), NOW) === 2);
check('a note older than a week has expired (the top rung is tried again)', readStart(store({ [RUNG_KEY]: `inst@${NOW - RUNG_TTL_MS - 1}` }), NOW) === 0);
check('junk, an unknown rung and a missing time are ignored', ['inst', 'turbo@123', 'inst@', '@123', 'INST@5', '__proto__@1'].every((v) => readStart(store({ [RUNG_KEY]: v }), NOW) === 0));
{
  const s = store();
  writeRung(s, 'inst', NOW);
  check('writeRung stores a lower rung with the time, and readStart reads it back', s.get(RUNG_KEY) === `inst@${NOW}` && readStart(s, NOW + 5000) === 1);
  writeRung(s, 'tex', NOW);
  check('writing the top rung clears the note', s.get(RUNG_KEY) === null);
  writeRung(s, 'cpu', NOW);
  writeRung(s, 'nonsense', NOW);
  check('an unknown rung clears the note too', s.get(RUNG_KEY) === null);
}

console.log(JSON.stringify({ total, failed }));
process.exit(failed ? 1 : 0);
