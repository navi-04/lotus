/**
 * Deterministic random numbers. NEVER use Math.random() in the scene: screenshots must be reproducible.
 *   const rng = makeRng(123);  rng.next() -> [0,1)   rng.range(a,b)   rng.int(a,b)   rng.gauss()   rng.sign()
 *   const sub = rng.fork('petals');  // independent stream derived from a label
 */

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed = 1) {
  const seedNum = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
  const f = mulberry32(seedNum);
  let spare = null;
  const rng = {
    seed: seedNum,
    next: f,
    range: (a, b) => a + (b - a) * f(),
    int: (a, b) => Math.floor(a + (b - a + 1) * f()),
    sign: () => (f() < 0.5 ? -1 : 1),
    chance: (p) => f() < p,
    pick: (arr) => arr[Math.floor(f() * arr.length)],
    /** standard normal (Box-Muller), mean 0 sd 1 */
    gauss() {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let u = 0, v = 0;
      while (u === 0) u = f();
      while (v === 0) v = f();
      const m = Math.sqrt(-2 * Math.log(u));
      spare = m * Math.sin(2 * Math.PI * v);
      return m * Math.cos(2 * Math.PI * v);
    },
    /** independent sub-stream: same (seed,label) always yields the same sequence */
    fork(label) {
      return makeRng((seedNum ^ hashString(String(label))) >>> 0);
    },
  };
  return rng;
}
