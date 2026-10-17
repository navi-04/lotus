#!/usr/bin/env node
/**
 * Unit checks for effect shedding (no browser): node tools/shed-check.mjs
 */
import { SHED_KEY, SHED_TTL_MS, SHED_MAX, SHED_LEVELS, shedSettings, readShed, writeShed, createShedder } from '../src/core/shed.js';

let failed = 0, total = 0;
const check = (name, ok, info = '') => { total++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); };

const NOW = 1_700_000_000_000;
const store = (init = {}) => { const m = new Map(Object.entries(init)); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { if (v == null) m.delete(k); else m.set(k, String(v)); return true; }, m }; };

// ---- the levels ------------------------------------------------------------------------------------------------------------------
check('three levels, 0..2', SHED_LEVELS.length === SHED_MAX + 1 && SHED_MAX === 2);
check('level 0 is the full scene', JSON.stringify(shedSettings(0)) === JSON.stringify({ dofScale: 1, shadowEvery: 1, reflectionEvery: 1, reflectionScale: 1 }));
check('each level is cheaper than the one before (never brings anything back)', SHED_LEVELS.every((l, i) => i === 0 || (l.shadowEvery >= SHED_LEVELS[i - 1].shadowEvery && l.reflectionEvery >= SHED_LEVELS[i - 1].reflectionEvery && l.reflectionScale <= SHED_LEVELS[i - 1].reflectionScale && l.dofScale <= SHED_LEVELS[i - 1].dofScale)));
check('every effect stays in the picture: nothing is switched off outright', SHED_LEVELS.every((l) => l.dofScale > 0 && l.reflectionScale > 0 && l.shadowEvery >= 1 && l.reflectionEvery >= 1));
check('shedSettings clamps junk (-3, 99, 1.7, NaN)', shedSettings(-3) === SHED_LEVELS[0] && shedSettings(99) === SHED_LEVELS[2] && shedSettings(1.7) === SHED_LEVELS[1] && shedSettings(NaN) === SHED_LEVELS[0]);

// ---- the week-long memory -------------------------------------------------------------------------------------------------------
check('nothing stored: level 0', readShed(store(), NOW) === 0);
check('a fresh note is read back', readShed(store({ [SHED_KEY]: `1@${NOW - 1000}` }), NOW) === 1 && readShed(store({ [SHED_KEY]: `2@${NOW}` }), NOW) === 2);
check('a note just under a week old still applies', readShed(store({ [SHED_KEY]: `2@${NOW - SHED_TTL_MS + 1000}` }), NOW) === 2);
check('a note older than a week has expired', readShed(store({ [SHED_KEY]: `2@${NOW - SHED_TTL_MS - 1}` }), NOW) === 0);
check('a level above the maximum is clamped', readShed(store({ [SHED_KEY]: `9@${NOW}` }), NOW) === SHED_MAX);
check('junk is ignored', ['', 'x', '1', '@5', '1@', '-1@5', '1.5@5', 'a@b'].every((v) => readShed(store({ [SHED_KEY]: v }), NOW) === 0));
{
  const s = store();
  writeShed(s, 1, NOW);
  check('writeShed stores the level and the time', s.get(SHED_KEY) === `1@${NOW}` && readShed(s, NOW + 5) === 1);
  writeShed(s, 7, NOW);
  check('writeShed clamps the level', s.get(SHED_KEY) === `${SHED_MAX}@${NOW}`);
  writeShed(s, 0, NOW);
  check('writing level 0 clears the note', s.get(SHED_KEY) === null);
}

// ---- when to shed -----------------------------------------------------------------------------------------------------------------
{
  const s = createShedder();
  let got = null, t = 0;
  while (t < 20 && got == null) { got = s.update(0.1, true); t += 0.1; }
  check('exhausted for ~5 s takes level 1', got === 1 && t >= 4.9 && t <= 5.3, `level ${got} after ${t.toFixed(1)} s`);
  let got2 = null; t = 0;
  while (t < 30 && got2 == null) { got2 = s.update(0.1, true); t += 0.1; }
  check('then ~9 s more takes level 2 (the new level gets a fair trial)', got2 === 2 && t >= 8.9 && t <= 9.3, `level ${got2} after ${t.toFixed(1)} s`);
  check('nothing beyond the last level, and the governor is told it can no longer shed', s.update(100, true) === null && s.level === 2 && s.canShed === false);
}
{
  const s = createShedder();
  for (let i = 0; i < 40; i++) s.update(0.1, true);                // 4 s: almost there
  for (let i = 0; i < 60; i++) s.update(0.1, false);               // a calm spell
  let lv = null;
  for (let i = 0; i < 40 && lv == null; i++) lv = s.update(0.1, true);
  check('a calm spell lets the clock run down: 4 s + calm + 4 s does not shed', lv == null);
  check('a started shedder reports it can shed at level 0 and 1', s.canShed === true && createShedder({ level: 1 }).canShed === true && createShedder({ level: 2 }).canShed === false);
}
check('a shedder can start at the remembered level (clamped)', createShedder({ level: 1 }).level === 1 && createShedder({ level: 9 }).level === 2 && createShedder({ level: -2 }).level === 0);
{
  const s = createShedder({ level: 1 });
  let got = null, t = 0;
  while (t < 30 && got == null) { got = s.update(0.1, true); t += 0.1; }
  check('starting at level 1, the next step takes the longer wait', got === 2 && t >= 8.9, `after ${t.toFixed(1)} s`);
}

console.log(JSON.stringify({ total, failed }));
process.exit(failed ? 1 : 0);
