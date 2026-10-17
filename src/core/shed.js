/**
 * Effect shedding - the last thing tried before the picture goes blurry.
 *
 * The frame governor (render/adaptive.js) lowers the pixel ratio and the frame rate. When even the slowest pace at a comfortable pixel
 * ratio is still late, the device is too weak for the scene as drawn, and the cheapest things to give up are the ones nobody can point
 * at: how sharp the depth-of-field blur is computed (it is a blur), and how OFTEN the shadows and the water reflection are refreshed
 * (they keep their size and softness).
 *
 *   level 0  everything as the tier says
 *   level 1  depth-of-field blur at half resolution; shadows and reflection refreshed every second frame
 *   level 2  shadows every third frame; the reflection drawn at a fifth of the size (the blur stays at half: smaller shows stair-steps)
 *
 * The level is remembered for a week (`lotus.shed`) so a weak phone is smooth from the first second of the next visit.
 * Pure logic with injected storage and time, unit-tested in Node (tools/shed-check.mjs).
 */
export const SHED_KEY = 'lotus.shed';
export const SHED_TTL_MS = 7 * 24 * 3600 * 1000;
export const SHED_MAX = 2;

/** what each level asks of the renderer */
export const SHED_LEVELS = [
  { dofScale: 1, shadowEvery: 1, reflectionEvery: 1, reflectionScale: 1 },
  { dofScale: 0.5, shadowEvery: 2, reflectionEvery: 2, reflectionScale: 1 },
  { dofScale: 0.5, shadowEvery: 3, reflectionEvery: 2, reflectionScale: 0.2 },
];

export const shedSettings = (level) => SHED_LEVELS[Math.min(SHED_MAX, Math.max(0, level | 0))];

/** the remembered level while it is fresh, else 0 */
export function readShed(store, now = Date.now()) {
  const m = /^(\d+)@(\d+)$/.exec(store.get(SHED_KEY) || '');
  if (!m || now - Number(m[2]) > SHED_TTL_MS) return 0;
  return Math.min(SHED_MAX, Number(m[1]));
}

export function writeShed(store, level, now = Date.now()) {
  store.set(SHED_KEY, level > 0 ? `${Math.min(SHED_MAX, level)}@${now}` : null);
}

/**
 * Decides when to shed: the governor reports `exhausted` each frame; after `after` seconds of it the next level is taken, and the clock
 * starts again so the new level gets a fair trial. Returns the new level when one was taken, else null.
 */
export function createShedder({ level = 0, firstAfter = 5, nextAfter = 9 } = {}) {
  let lvl = Math.min(SHED_MAX, Math.max(0, level | 0)), t = 0;
  return {
    get level() { return lvl; },
    /** the governor may still ask for lighter effects (so it keeps the comfortable pixel ratio instead of going blurrier) */
    get canShed() { return lvl < SHED_MAX; },
    update(dt, exhausted) {
      if (!exhausted || lvl >= SHED_MAX) { t = Math.max(0, t - dt); return null; }
      t += dt;
      if (t < (lvl === 0 ? firstAfter : nextAfter)) return null;
      t = 0;
      lvl++;
      return lvl;
    },
  };
}
