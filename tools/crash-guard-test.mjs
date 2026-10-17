#!/usr/bin/env node
/**
 * Unit tests for src/core/crashGuard.js (no browser needed): node tools/crash-guard-test.mjs
 * Fake storage / clock / Web Locks stand in for the browser, so every scenario is deterministic.
 */
import {
  armCrashGuard, handleContextRestored, readSafe, bumpSafe, clearSafe,
  BOOT_KEY, SAFE_KEY, SAFE_TTL_MS, BOOT_TTL_MS, UNKNOWN_GRACE_MS,
} from '../src/core/crashGuard.js';

let failed = 0, total = 0;
const check = (name, ok, info = '') => { total++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); };

function mem() { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { if (v == null) m.delete(k); else m.set(k, String(v)); return true; }, m }; }

/** a "machine": shared localStorage + lock table + clock; each browser tab gets its own sessionStorage and env */
function machine({ locks = true } = {}) {
  const ls = mem();
  const held = new Set();
  const clock = { t: 1_700_000_000_000 };
  let n = 0;
  const tab = ({ hidden = false } = {}) => {
    const ss = mem();
    let myLock = null;
    const hideHandlers = [];
    const env = {
      ls, ss, now: () => clock.t, newId: () => `boot-${++n}`,
      isAlive: async (id) => (locks ? held.has(id) : null),
      hold: (id) => { if (locks) { held.add(id); myLock = id; } },
      release: () => { if (myLock) { held.delete(myLock); myLock = null; } },
      onPageHide: (fn) => hideHandlers.push(fn),
      isHidden: () => hidden,
    };
    return { env, ss, pagehide: () => hideHandlers.forEach((f) => f()), die: () => { if (myLock) { held.delete(myLock); myLock = null; } } };
  };
  return { ls, held, clock, tab };
}

// 1. clean boot
{
  const M = machine(); const a = M.tab();
  const g = await armCrashGuard(a.env);
  check('clean boot: not a crash, flag armed, lock held', !g.crashed && !!M.ls.get(BOOT_KEY) && M.held.size === 1);
  g.disarm();
  check('disarm clears the flag and releases the lock', M.ls.get(BOOT_KEY) === null && M.held.size === 0);
  g.disarm();
  check('disarm is idempotent', M.ls.get(BOOT_KEY) === null);
  check('no step-down after a clean boot', readSafe(a.env) === 0);
}

// 2. previous boot died (lock gone) -> crash
{
  const M = machine(); const a = M.tab();
  const g1 = await armCrashGuard(a.env);
  a.die();                                         // the tab is killed: lock released, flag left behind
  M.clock.t += 30_000;
  const b = M.tab();
  const g2 = await armCrashGuard(b.env);
  check('a boot that died is detected by the next boot', g2.crashed && readSafe(b.env) === 1);
  g2.disarm();
  check('the dead boot flag is replaced and cleared by the healthy boot', M.ls.get(BOOT_KEY) === null);
  void g1;
}

// 3. two windows booting at once -> NOT a crash
{
  const M = machine(); const a = M.tab(); const b = M.tab();
  const ga = await armCrashGuard(a.env);
  M.clock.t += 1500;
  const gb = await armCrashGuard(b.env);
  check('second window booting while the first is alive: no crash, no step-down', !gb.crashed && readSafe(b.env) === 0);
  ga.disarm();
  check("the first window's disarm leaves the second window's flag alone", JSON.parse(M.ls.get(BOOT_KEY)).id === gb.id);
  gb.disarm();
  check('then the second window clears it', M.ls.get(BOOT_KEY) === null);
}

// 4. a window that is alive but hidden mid-load must not clear the flag (the real out-of-memory kill happens in the background)
{
  const M = machine(); const a = M.tab({ hidden: true });
  await armCrashGuard(a.env);
  check('hidden tab keeps its flag (only pagehide / frames clear it)', !!M.ls.get(BOOT_KEY));
  a.die(); M.clock.t += 60_000;
  const b = M.tab(); const g = await armCrashGuard(b.env);
  check('...so a background kill is caught on the next load', g.crashed);
}

// 5. normal exit mid-load (pagehide) leaves nothing behind
{
  const M = machine(); const a = M.tab();
  await armCrashGuard(a.env);
  a.pagehide(); a.die();
  const b = M.tab(); const g = await armCrashGuard(b.env);
  check('closing the tab mid-load (pagehide) is not a crash', !g.crashed && readSafe(b.env) === 0);
}

// 6. no Web Locks: only an old-enough flag counts
{
  const M = machine({ locks: false }); const a = M.tab();
  await armCrashGuard(a.env);
  M.clock.t += 3000;
  const b = M.tab(); const gb = await armCrashGuard(b.env);
  check('no Web Locks: a 3 s old flag is treated as another window loading', !gb.crashed);
  const M2 = machine({ locks: false }); const a2 = M2.tab();
  await armCrashGuard(a2.env);
  M2.clock.t += UNKNOWN_GRACE_MS + 5000;
  const b2 = M2.tab(); const gb2 = await armCrashGuard(b2.env);
  check('no Web Locks: a flag older than the grace period counts as a crash', gb2.crashed);
}

// 7. stale flag (older than the TTL) is ignored
{
  const M = machine(); const a = M.tab();
  await armCrashGuard(a.env); a.die();
  M.clock.t += BOOT_TTL_MS + 1000;
  const b = M.tab(); const g = await armCrashGuard(b.env);
  check('a flag older than 10 minutes is ignored', !g.crashed);
}

// 8. step-down: caps, expiry, clear, garbage
{
  const M = machine(); const e = M.tab().env;
  bumpSafe(e); bumpSafe(e); bumpSafe(e); bumpSafe(e); bumpSafe(e);
  check('step-down caps at 3', readSafe(e) === 3);
  M.clock.t += SAFE_TTL_MS - 1000;
  check('...and is still active just before it expires', readSafe(e) === 3);
  M.clock.t += 2000;
  check('...and expires after a week', readSafe(e) === 0);
  bumpSafe(e); clearSafe(e);
  check('clearSafe removes it', readSafe(e) === 0);
  for (const junk of ['', 'abc', '2', '2@', '@5', '-1@5', '2@abc', '9999999999999999999@1']) { M.ls.set(SAFE_KEY, junk); if (readSafe(e) !== 0 && junk !== '9999999999999999999@1') check(`garbage '${junk}' reads as 0`, false); }
  M.ls.set(SAFE_KEY, `99@${M.clock.t}`);
  check('absurd stored count is clamped to 3', readSafe(e) === 3);
  M.ls.set(SAFE_KEY, 'abc');
  check('garbage reads as 0', readSafe(e) === 0);
}

// 9. context loss: reload counter, loop breaker, pinned / hidden
{
  const M = machine(); const t = M.tab();
  check('1st context restore: reload allowed', handleContextRestored({ pinned: false }, t.env) === true && readSafe(t.env) === 1);
  M.clock.t += 5000;
  check('2nd context restore: reload allowed', handleContextRestored({ pinned: false }, t.env) === true && readSafe(t.env) === 2);
  M.clock.t += 5000;
  check('3rd within a minute: reload refused (loop breaker), no further step-down', handleContextRestored({ pinned: false }, t.env) === false && readSafe(t.env) === 2);
  M.clock.t += 100_000;
  check('after the window passes, reloading is allowed again', handleContextRestored({ pinned: false }, t.env) === true);
}
{
  const M = machine(); const t = M.tab();
  check('pinned ?quality=: reload allowed but no step-down recorded', handleContextRestored({ pinned: true }, t.env) === true && readSafe(t.env) === 0);
  const M2 = machine(); const h = M2.tab({ hidden: true });
  check('context restored while hidden (benign): reload allowed, no step-down', handleContextRestored({ pinned: false }, h.env) === true && readSafe(h.env) === 0);
}

// 10. blocked storage never throws and never loops
{
  const dead = { get: () => null, set: () => false };
  const env = { ls: dead, ss: dead, now: () => 1e12, newId: () => 'x', isAlive: async () => null, hold() {}, release() {}, onPageHide() {}, isHidden: () => false };
  const g = await armCrashGuard(env);
  check('blocked storage: boot guard is a harmless no-op', !g.crashed && readSafe(env) === 0);
  g.disarm();
  check('blocked storage: context restore still reloads (nothing to count)', handleContextRestored({}, env) === true);
}

console.log(JSON.stringify({ total, failed }));
process.exit(failed ? 1 : 0);
