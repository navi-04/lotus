/**
 * Petal shape - what the petals ARE, independent of how they get drawn.
 *
 * Whorl definitions, the per-petal random parameters, and the per-frame CPU integration of every petal's inextensible CENTRE LINE
 * from a bending-angle law theta(u) (angle from the flower axis, + = outward). The result is two per-row tables:
 *   A = (radial, vertical, theta, half-width)      B = (cup curvature, twist, ruffle amplitude, shell offset)
 * Three renderers consume them (see petals.js): a GPU path that reads them from float textures, one that reads them from instanced
 * vertex attributes, and a plain CPU path that builds the surface itself. They all produce the same flower.
 */
import { smoothstep, lerp, clamp01 } from '../core/timeline.js';

const D = Math.PI / 180;
const TWO_PI = Math.PI * 2;

/**
 * Whorl definitions. Angles are degrees from the flower axis (+ = leaning outward). t0 = angle at the base,
 * t1 = angle at the tip, p = how late the bending happens along the length (>1 = near the tip); c = closed
 * bud, o = fully open. cup = cross-section curvature (1/radius, units^-1). All ranges are [min,max] per petal.
 */
export const WHORLS = [
  { name: 'outer', n: 5, layer: 0.0, L: [1.10, 1.24], W: [0.74, 0.88], r0: 0.15, y0: -0.03,
    t0c: [16, 22], t1c: [-46, -36], pc: 1.5, t0o: [40, 50], t1o: [70, 88], po: 1.3, curlO: [6, 14],
    cupC: [2.6, 3.2], cupO: [0.8, 1.1], twC: [0.10, 0.22], twO: [-0.12, 0.12], ruffle: [0.012, 0.03],
    tipSharp: [0.46, 0.58], start: 0.04, end: 0.58 },
  { name: 'mid', n: 6, layer: 0.34, L: [1.02, 1.16], W: [0.72, 0.84], r0: 0.135, y0: 0.0,
    t0c: [20, 26], t1c: [-50, -40], pc: 1.5, t0o: [34, 44], t1o: [60, 76], po: 1.3, curlO: [4, 10],
    cupC: [2.8, 3.4], cupO: [1.0, 1.3], twC: [0.10, 0.20], twO: [-0.10, 0.10], ruffle: [0.010, 0.026],
    tipSharp: [0.46, 0.58], start: 0.14, end: 0.70 },
  { name: 'inner', n: 6, layer: 0.67, L: [0.86, 0.98], W: [0.64, 0.74], r0: 0.12, y0: 0.02,
    t0c: [26, 32], t1c: [-56, -46], pc: 1.5, t0o: [36, 46], t1o: [62, 78], po: 1.3, curlO: [3, 9],
    cupC: [3.0, 3.6], cupO: [1.2, 1.6], twC: [0.08, 0.18], twO: [-0.08, 0.08], ruffle: [0.008, 0.02],
    tipSharp: [0.46, 0.56], start: 0.26, end: 0.84 },
  { name: 'core', n: 5, layer: 1.0, L: [0.62, 0.72], W: [0.50, 0.60], r0: 0.11, y0: 0.04,
    t0c: [26, 32], t1c: [-62, -54], pc: 1.8, t0o: [40, 50], t1o: [60, 74], po: 1.3, curlO: [0, 6],
    cupC: [3.2, 4.0], cupO: [1.5, 2.0], twC: [0.06, 0.14], twO: [-0.06, 0.06], ruffle: [0.006, 0.014],
    tipSharp: [0.46, 0.56], start: 0.38, end: 0.97 },
];

/** planform half-width profile, 0..1: elliptic-ovate, widest ~58%, narrow claw base, rounded-to-pointed apex */
export function planform(u, tipSharp) {
  const a = Math.pow(u, 1.27);
  const b = lerp(0.62, tipSharp, smoothstep(0.30, 1.0, u));
  return Math.pow(Math.max(Math.sin(Math.PI * a), 0), b);
}

export function buildPetalParams(rng) {
  const out = [];
  let idx = 0;
  const total = WHORLS.reduce((s, w) => s + w.n, 0);
  WHORLS.forEach((w, wi) => {
    const step = TWO_PI / w.n;
    const offset = rng.range(0, step) + wi * 0.5 * step;
    for (let k = 0; k < w.n; k++) {
      const r = (a) => rng.range(a[0], a[1]);
      out.push({
        index: idx++, whorl: wi, k,
        layer: w.layer,
        seed: rng.next(),
        phi: offset + k * step + rng.range(-0.16, 0.16) * step,
        L: r(w.L), W: r(w.W), tipSharp: r(w.tipSharp),
        r0: w.r0 + rng.range(-0.01, 0.01), y0: w.y0 + rng.range(-0.01, 0.01),
        t0c: r(w.t0c) * D, t1c: r(w.t1c) * D, pc: w.pc * rng.range(0.95, 1.08),
        t0o: r(w.t0o) * D, t1o: r(w.t1o) * D, po: w.po * rng.range(0.92, 1.1), curlO: r(w.curlO) * D,
        cupC: r(w.cupC), cupO: r(w.cupO), twC: r(w.twC), twO: r(w.twO), ruffle: r(w.ruffle),
        shell: lerp(0.034, 0.0, w.layer),
        start: clamp01(w.start + rng.range(-0.035, 0.035) + k * 0.012),
        end: clamp01(w.end + rng.range(-0.035, 0.035) + k * 0.008),
        flutterPhase: rng.range(0, TWO_PI), flutterFreq: rng.range(1.5, 2.6),
      });
    }
  });
  out.total = total;
  return out;
}

const easeIO = (x) => x * x * (3 - 2 * x);

/**
 * Integrates every petal's centre line into the two row tables for the current frame.
 * Row `k` of petal `i` lives at ((i * (NU + 1)) + k) * 4 in both tables; `open[i]` is that petal's openness 0..1.
 * Also writes frame.flowerRadius (mean outer-whorl radius), which the camera and the stem read.
 */
export function createRowIntegrator(params, NU) {
  const NP = params.length;
  const ROWS = NU + 1;
  const dataA = new Float32Array(ROWS * NP * 4);
  const dataB = new Float32Array(ROWS * NP * 4);
  const open = new Float32Array(NP);

  function step(frame) {
    const bloom = frame.bloom;
    const t = frame.time;
    const windMag = Math.min(1, Math.hypot(frame.wind.x, frame.wind.z));
    let outerR = 0, outerN = 0;
    for (let i = 0; i < NP; i++) {
      const P = params[i];
      const x = clamp01((bloom - P.start) / (P.end - P.start));
      const o = easeIO(x);
      const oBase = smoothstep(0.2, 1.0, o);
      const oTip = smoothstep(0.0, 0.75, o);
      const oCup = smoothstep(0.05, 0.95, o);
      const t0 = lerp(P.t0c, P.t0o, oBase);
      const t1 = lerp(P.t1c, P.t1o, oTip);
      const pw = lerp(P.pc, P.po, o);
      const curl = P.curlO * oTip;
      const cup = lerp(P.cupC, P.cupO, oCup);
      const tw = lerp(P.twC, P.twO, o);
      const breath = Math.sin(t * 0.7 + P.phi) * 0.012 * o;
      const flut = (0.010 + 0.03 * windMag) * Math.sin(t * P.flutterFreq + P.flutterPhase) * o + breath;
      const ruf = P.ruffle * (0.35 + 0.65 * o);

      let r = P.r0, y = P.y0;
      const row0 = i * ROWS * 4;
      const stepL = P.L / NU;
      let maxR = 0;
      for (let k = 0; k <= NU; k++) {
        const u = k / NU;
        const sm = clamp01((u - 0.55) / 0.45);
        const th = t0 + (t1 - t0) * Math.pow(u, pw) + curl * sm * sm + flut * u * u;
        const j = row0 + k * 4;
        dataA[j] = r; dataA[j + 1] = y; dataA[j + 2] = th;
        dataA[j + 3] = 0.5 * P.W * planform(u, P.tipSharp);
        dataB[j] = cup * (0.45 + 0.55 * Math.sin(Math.PI * Math.pow(u, 0.8)));
        dataB[j + 1] = tw * Math.pow(u, 1.3);
        dataB[j + 2] = ruf * smoothstep(0.15, 0.9, u);
        dataB[j + 3] = P.shell;
        if (r > maxR) maxR = r;
        if (k < NU) {
          const um = (k + 0.5) / NU;
          const sm2 = clamp01((um - 0.55) / 0.45);
          const thm = t0 + (t1 - t0) * Math.pow(um, pw) + curl * sm2 * sm2 + flut * um * um;
          r += Math.sin(thm) * stepL;
          y += Math.cos(thm) * stepL;
        }
      }
      if (P.whorl === 0) { outerR += maxR; outerN++; }
      open[i] = o;
    }
    if (outerN) frame.flowerRadius = outerR / outerN;
  }

  return { NU, ROWS, NP, dataA, dataB, open, step };
}
