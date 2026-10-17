/**
 * The petal ladder - how the app makes sure the petals actually show up on whatever GPU it lands on.
 *
 * The petals are the one part of the flower that needs more than stock drawing, and phone GPUs differ in what they accept. So the app
 * proves it: it draws just the petals into a tiny hidden image and counts pixels (petalProbe.js). If nothing shows, it moves one rung
 * down to a simpler way of drawing the same flower and tries again:
 *
 *   tex       float data textures + the full petal skin           (desktops)
 *   inst      the same data as instanced vertex attributes        (no vertex texture fetch, no uniform-array indexing)
 *   instlite  instanced + a lighter skin (no noise, veins, derivatives)
 *   cpu       surface built in JavaScript, stock material         (needs nothing special)
 *
 * The rung that worked is remembered for a week so a device that needed a lower rung does not pay for the failed ones every visit.
 * Pure logic with injected callbacks, so it is unit-tested in Node (tools/petal-ladder-test.mjs).
 */
export const RUNGS = ['tex', 'inst', 'instlite', 'cpu'];
export const RUNG_KEY = 'lotus.petals';
export const RUNG_TTL_MS = 7 * 24 * 3600 * 1000;
export const MIN_PIXELS = 40;          // of 64 x 64: a bud fills about a tenth of the probe image, so this is far below any working result

/** `?petals=` value -> a rung id, or null for "decide yourself" (also for 'auto' and for junk) */
export function parseForced(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return RUNGS.includes(v) ? v : null;
}

/** index of the rung to start on: the remembered one while it is fresh, else the top */
export function readStart(store, now = Date.now()) {
  const m = /^([a-z]+)@(\d+)$/.exec(store.get(RUNG_KEY) || '');
  if (!m) return 0;
  const i = RUNGS.indexOf(m[1]);
  if (i < 0 || now - Number(m[2]) > RUNG_TTL_MS) return 0;
  return i;
}

/** remember a rung below the top; the top needs no memory (a stale note is cleared) */
export function writeRung(store, id, now = Date.now()) {
  const i = RUNGS.indexOf(id);
  store.set(RUNG_KEY, i > 0 ? `${id}@${now}` : null);
}

/**
 * Walk down from `start` until a rung passes its probe.
 * @param {object} o
 * @param {number} [o.start]
 * @param {(id: string) => Promise<void>|void} o.build   make that rung the live one
 * @param {(id: string) => Promise<number>|number} o.probe  pixels the petals cover in the probe image
 * @returns {Promise<{id: string|null, ok: boolean, tried: {id: string, px: number, ok: boolean, err: string|null}[]}>}
 */
export async function settleLadder({ start = 0, build, probe, minPixels = MIN_PIXELS }) {
  const tried = [];
  for (let i = Math.max(0, start); i < RUNGS.length; i++) {
    const id = RUNGS[i];
    let px = 0, err = null;
    try { await build(id); px = await probe(id); } catch (e) { err = String((e && e.message) || e); }
    const ok = !err && px >= minPixels;
    tried.push({ id, px, ok, err });
    if (ok) return { id, ok: true, tried };
  }
  return { id: null, ok: false, tried };
}
