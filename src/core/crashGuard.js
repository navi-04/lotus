/**
 * Crash guard - keeps "everything max by default" from becoming "stuck on a device that cannot take it".
 *
 * Two silent self-healing rules, both of which only ever lower the DEFAULT tier (an explicit ?quality= always wins, see quality.js):
 *
 *  1. A boot that died before rendering (the tab was killed for GPU/memory, the driver reset) steps the next load down one tier.
 *     Detection: every boot writes {id, t} to localStorage and holds a Web Lock named after its id until its first frames are out
 *     (or the page is left normally). A later boot that finds a recent flag whose lock is no longer held knows that boot died -
 *     while a flag whose lock IS held is just another window that is still loading and is left alone. Without the Web Locks API
 *     the flag only counts once it is a few seconds old.
 *  2. A lost-and-restored WebGL context reloads the page one tier lower - unless the tab was hidden at the time (benign: mobile
 *     backgrounding, sleep/wake) - and never more than twice in a minute (a loop breaker; the app then stays put and says so).
 *
 * The step-down (`lotus.safe` = "<steps>@<epoch ms>") expires after a week, so one bad moment never lowers a device for good.
 * All state sits behind an injectable `env`, so the logic is unit-tested in Node (tools/crash-guard-test.mjs).
 */
import { local, session } from './storage.js';

export const BOOT_KEY = 'lotus.boot';
export const SAFE_KEY = 'lotus.safe';
export const RELOAD_KEY = 'lotus.reloads';
export const SAFE_TTL_MS = 7 * 24 * 3600 * 1000;
export const BOOT_TTL_MS = 10 * 60 * 1000;
export const UNKNOWN_GRACE_MS = 8000;
const LOCK_PREFIX = 'lotus-boot-';

/** the real browser environment; tests pass their own */
export function browserEnv() {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  let release = null;
  return {
    ls: local,
    ss: session,
    now: () => Date.now(),
    newId: () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`),
    /** true / false = is that boot's lock still held; null = cannot tell (no Web Locks) */
    async isAlive(id) {
      try {
        if (!locks || !locks.query) return null;
        const q = await locks.query();
        return (q.held || []).some((l) => l.name === LOCK_PREFIX + id);
      } catch (e) { return null; }
    },
    hold(id) {
      try {
        if (!locks || !locks.request) return;
        locks.request(LOCK_PREFIX + id, () => new Promise((res) => { release = res; })).catch(() => {});
      } catch (e) { /* ignore */ }
    },
    release() { if (release) { release(); release = null; } },
    onPageHide(fn) { if (typeof window !== 'undefined') window.addEventListener('pagehide', fn); },
    isHidden: () => typeof document !== 'undefined' && document.hidden === true,
  };
}

/** how many tiers the default is currently stepped down (0..3) */
export function readSafe(env = browserEnv()) {
  const m = /^(\d+)@(\d+)$/.exec(env.ls.get(SAFE_KEY) || '');
  if (!m) return 0;
  if (env.now() - Number(m[2]) > SAFE_TTL_MS) return 0;
  return Math.min(3, Number(m[1]));
}
export function bumpSafe(env = browserEnv()) {
  env.ls.set(SAFE_KEY, `${Math.min(3, readSafe(env) + 1)}@${env.now()}`);
}
export function clearSafe(env = browserEnv()) {
  env.ls.set(SAFE_KEY, null);
}

function parseBoot(raw) {
  try {
    const o = JSON.parse(raw);
    return o && typeof o.id === 'string' && Number.isFinite(o.t) ? o : null;
  } catch (e) { return null; }
}

/**
 * Call once, first thing at boot. Arms the flag, and bumps the step-down if the previous boot demonstrably died.
 * @returns {Promise<{crashed: boolean, id: string, disarm: () => void}>}  call disarm() once frames are flowing
 */
export async function armCrashGuard(env = browserEnv()) {
  const id = env.newId();
  let crashed = false;
  const prev = parseBoot(env.ls.get(BOOT_KEY));
  if (prev && prev.id !== id) {
    const age = env.now() - prev.t;
    if (age >= 0 && age < BOOT_TTL_MS) {
      const alive = await env.isAlive(prev.id);
      crashed = alive === false || (alive === null && age > UNKNOWN_GRACE_MS);
    }
  }
  if (crashed) bumpSafe(env);

  env.ls.set(BOOT_KEY, JSON.stringify({ id, t: env.now() }));
  env.hold(id);
  let done = false;
  const disarm = () => {
    if (done) return;
    done = true;
    const cur = parseBoot(env.ls.get(BOOT_KEY));
    if (cur && cur.id === id) env.ls.set(BOOT_KEY, null);     // never erase another window's flag
    env.release();
  };
  env.onPageHide(disarm);
  return { crashed, id, disarm };
}

/**
 * The WebGL context was lost and has come back. Decide what to do.
 * @param {{pinned: boolean}} opts   pinned = the URL fixes the tier (?quality=), so there is nothing to step down
 * @returns {boolean} true = reload the page now; false = reloading is not allowed (too many reloads) - stay put and tell the user
 */
export function handleContextRestored({ pinned = false } = {}, env = browserEnv()) {
  const windowMs = 90 * 1000;
  const stamps = (env.ss.get(RELOAD_KEY) || '').split(',').map(Number).filter((t) => Number.isFinite(t) && t > 0 && env.now() - t < windowMs);
  if (stamps.length >= 2) return false;
  stamps.push(env.now());
  env.ss.set(RELOAD_KEY, stamps.join(','));
  if (!pinned && !env.isHidden()) bumpSafe(env);
  return true;
}
