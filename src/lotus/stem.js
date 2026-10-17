/**
 * Stem - the hero lotus peduncle: thorny olive-green stalk that lifts the bud out of the water, a nodding bud that
 * straightens as it opens, wind sway, and the head anchor that petals / pod / stamens attach to.
 *
 * The stalk is rebuilt on the CPU every frame (~1-2k vertices): a path integrated from a rest tangent field (S-curve),
 * with the visible length growing with `frame.rise`, plus a nod bend near the head and a cantilever sway. Prickles are
 * an InstancedMesh riding on the rings.
 */
import {
  Group, Object3D, Mesh, BufferGeometry, BufferAttribute, Uint16BufferAttribute, MeshStandardMaterial, InstancedMesh,
  ConeGeometry, Matrix4, Vector3, Quaternion, Color, DynamicDrawUsage,
} from 'three';
import { SCENE, PALETTE } from '../core/constants.js';
import { smoothstep, lerp, clamp01 } from '../core/timeline.js';

const TAU = Math.PI * 2;

export function createStem(ctx) {
  const tier = ctx.quality.tier;
  const rng = ctx.rng.fork('stem');
  const baseY = SCENE.stem.baseY;
  const headY = SCENE.stem.headY;
  const topR = SCENE.stem.topRadius;
  const baseR = SCENE.stem.baseRadius;

  const NRING = { low: 56, medium: 80, high: 110, ultra: 150 }[tier] || 100;
  const NRAD = { low: 8, medium: 10, high: 14, ultra: 18 }[tier] || 12;
  const NPRICK = { low: 140, medium: 240, high: 380, ultra: 560 }[tier] || 300;

  // ---- rest tangent field (S-curve), calibrated so the head ends up above the origin -------------------------
  const ph = [rng.range(0, TAU), rng.range(0, TAU), rng.range(0, TAU), rng.range(0, TAU)];
  const slope = (s) => ({
    x: 0.10 * Math.sin(0.9 * s + ph[0]) + 0.045 * Math.sin(2.1 * s + ph[1]),
    z: 0.09 * Math.sin(0.7 * s + ph[2]) + 0.04 * Math.sin(1.7 * s + ph[3]),
  });
  let cx = 0, cz = 0;
  let S1 = headY - baseY;
  for (let iter = 0; iter < 8; iter++) {
    let x = 0, y = baseY, z = 0;
    const n = 400;
    // find the arclength at which y reaches headY
    let ds = 0.02;
    let s = 0;
    for (let i = 0; i < 2000 && y < headY; i++) {
      const sl = slope(s);
      const tx = sl.x + cx, tz = sl.z + cz;
      const inv = 1 / Math.hypot(tx, 1, tz);
      x += tx * inv * ds; y += inv * ds; z += tz * inv * ds; s += ds;
    }
    S1 = s;
    cx -= x / S1; cz -= z / S1;
  }
  const restTangent = (s, out) => {
    const sl = slope(s);
    return out.set(sl.x + cx, 1, sl.z + cz).normalize();
  };
  const sHead0 = 0.75;                      // arclength shown at rise = 0 (the whole bud is still under the water)

  // ---- geometry buffers --------------------------------------------------------------------------------------
  const cols = NRAD + 1;
  const nVert = (NRING + 1) * cols;
  const pos = new Float32Array(nVert * 3);
  const nor = new Float32Array(nVert * 3);
  const colr = new Float32Array(nVert * 3);
  const idx = [];
  for (let i = 0; i < NRING; i++) for (let j = 0; j < NRAD; j++) {
    const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3).setUsage(DynamicDrawUsage));
  geo.setAttribute('normal', new BufferAttribute(nor, 3).setUsage(DynamicDrawUsage));
  geo.setAttribute('color', new BufferAttribute(colr, 3).setUsage(DynamicDrawUsage));
  geo.setIndex(new Uint16BufferAttribute(idx, 1));
  const mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0 });
  const tube = new Mesh(geo, mat);
  tube.frustumCulled = false;
  tube.castShadow = true;
  tube.receiveShadow = true;

  // prickles
  const prickGeo = new ConeGeometry(0.011, 0.04, 5, 1);
  prickGeo.translate(0, 0.02, 0);                          // base at origin, tip along +Y
  const prickMat = new MeshStandardMaterial({ color: PALETTE.prickle, roughness: 0.6 });
  const prickles = new InstancedMesh(prickGeo, prickMat, NPRICK);
  prickles.instanceMatrix.setUsage(DynamicDrawUsage);
  prickles.frustumCulled = false;
  prickles.castShadow = true;
  const pr = [];
  for (let i = 0; i < NPRICK; i++) {
    pr.push({ f: Math.pow(rng.next(), 0.8), a: rng.range(0, TAU), size: rng.range(0.7, 1.4), tilt: rng.range(-0.1, 0.35) });
  }

  const group = new Group();
  group.name = 'stem';
  group.add(tube, prickles);
  const headAnchor = new Object3D();
  headAnchor.name = 'headAnchor';
  group.add(headAnchor);

  // ---- per-frame state ---------------------------------------------------------------------------------------
  const T = new Vector3(), P = new Vector3(), N = new Vector3(), B = new Vector3(), prevN = new Vector3();
  const nodDir = new Vector3(0.55, 0, 0.83).normalize();
  const nodAxis = new Vector3();
  const tmp = new Vector3(), tmp2 = new Vector3();
  const centers = new Float32Array((NRING + 1) * 3);
  const tangents = new Float32Array((NRING + 1) * 3);
  const normals1 = new Float32Array((NRING + 1) * 3);
  const radii = new Float32Array(NRING + 1);
  const cA = new Color(PALETTE.stem), cB = new Color(PALETTE.stemDark), cR = new Color('#9a6a52'), cWet = new Color('#35472a');
  const cc = new Color();
  const m4 = new Matrix4(), q4 = new Quaternion(), sc = new Vector3(), up = new Vector3(0, 1, 0);
  let lastRipple = -10;
  const Q = new Quaternion();

  function update(frame) {
    const rise = frame.rise;
    const sHead = lerp(sHead0, S1, 1 - Math.pow(1 - rise, 1.6));
    const ds = sHead / NRING;
    const wind = frame.wind;
    const t = frame.time;
    const nod = 0.62 * (1 - smoothstep(0.30, 1.0, rise)) * (1 - 0.8 * smoothstep(0.0, 0.3, frame.bloom));
    // integrate the path
    P.set(SCENE.stem.x, baseY, SCENE.stem.z);
    const nodStart = Math.max(0, sHead - 1.1);
    let havePrev = false;
    for (let i = 0; i <= NRING; i++) {
      const s = i * ds;
      restTangent(s, T);
      // cantilever sway: tilt grows with height (units of slope)
      const h = s / S1;
      const swayAmp = 0.030 + 0.10 * (0.4 + Math.hypot(wind.x, wind.z));
      const phase = t * 1.15;
      T.x += (wind.x * 0.5 + 0.28 * Math.sin(phase + 0.5)) * swayAmp * h * h * 1.8;
      T.z += (wind.z * 0.5 + 0.28 * Math.sin(phase * 0.83 + 1.7)) * swayAmp * h * h * 1.8;
      // nod: bend toward nodDir over the last stretch
      if (s > nodStart) {
        const w = (s - nodStart) / Math.max(sHead - nodStart, 1e-3);
        const a = nod * w * w * (3 - 2 * w);
        T.addScaledVector(nodDir, Math.tan(a) * 0.9 * w);
      }
      T.normalize();
      // rotation-minimising frame
      if (!havePrev) {
        N.set(1, 0, 0).addScaledVector(T, -T.x).normalize();
        havePrev = true;
      } else {
        N.copy(prevN).addScaledVector(T, -prevN.dot(T)).normalize();
      }
      prevN.copy(N);
      centers[i * 3] = P.x; centers[i * 3 + 1] = P.y; centers[i * 3 + 2] = P.z;
      tangents[i * 3] = T.x; tangents[i * 3 + 1] = T.y; tangents[i * 3 + 2] = T.z;
      normals1[i * 3] = N.x; normals1[i * 3 + 1] = N.y; normals1[i * 3 + 2] = N.z;
      const taper = smoothstep(0, S1, s);
      radii[i] = lerp(baseR, topR, taper) * (1 + 0.035 * Math.sin(s * 3.1 + ph[0]) + 0.02 * Math.sin(s * 9.3 + ph[2]));
      P.addScaledVector(T, ds);
    }
    // neck: the last rings flare slightly to meet the collar
    radii[NRING] *= 1.18; radii[NRING - 1] *= 1.08;

    // vertices
    for (let i = 0; i <= NRING; i++) {
      T.set(tangents[i * 3], tangents[i * 3 + 1], tangents[i * 3 + 2]);
      N.set(normals1[i * 3], normals1[i * 3 + 1], normals1[i * 3 + 2]);
      B.crossVectors(T, N);
      const r = radii[i];
      const y = centers[i * 3 + 1];
      // colour: olive green, pinkish-brown near the base, darker wet band at the waterline
      const f = i / NRING;
      cc.copy(cA).lerp(cB, 0.25 + 0.25 * Math.sin(f * 40 + ph[1]) * 0.5 + 0.1);
      cc.lerp(cR, 0.45 * (1 - smoothstep(-2.6, 0.9, y)));
      const wet = (1 - smoothstep(0.0, 0.55, y)) * smoothstep(-0.1, 0.05, y);
      cc.lerp(cWet, wet * 0.8);
      for (let j = 0; j <= NRAD; j++) {
        const a = (j / NRAD) * TAU;
        const ca = Math.cos(a), sa = Math.sin(a);
        const k = (i * cols + j) * 3;
        const nx = N.x * ca + B.x * sa, ny = N.y * ca + B.y * sa, nz = N.z * ca + B.z * sa;
        pos[k] = centers[i * 3] + nx * r; pos[k + 1] = centers[i * 3 + 1] + ny * r; pos[k + 2] = centers[i * 3 + 2] + nz * r;
        nor[k] = nx; nor[k + 1] = ny; nor[k + 2] = nz;
        const v = 1 + 0.07 * Math.sin(a * 6 + f * 11 + ph[3]);       // fine longitudinal striations
        colr[k] = cc.r * v; colr[k + 1] = cc.g * v; colr[k + 2] = cc.b * v;
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;

    // prickles ride the rings
    let shown = 0;
    for (let i = 0; i < NPRICK; i++) {
      const p = pr[i];
      const ringF = p.f * (NRING - 6);            // keep clear of the neck
      const i0 = Math.min(Math.floor(ringF), NRING - 1);
      const u = ringF - i0;
      const r = lerp(radii[i0], radii[i0 + 1], u);
      tmp.set(
        lerp(centers[i0 * 3], centers[i0 * 3 + 3], u),
        lerp(centers[i0 * 3 + 1], centers[i0 * 3 + 4], u),
        lerp(centers[i0 * 3 + 2], centers[i0 * 3 + 5], u));
      if (tmp.y < -0.15) { sc.set(0, 0, 0); m4.compose(tmp, q4.identity(), sc); prickles.setMatrixAt(i, m4); continue; }
      T.set(tangents[i0 * 3], tangents[i0 * 3 + 1], tangents[i0 * 3 + 2]);
      N.set(normals1[i0 * 3], normals1[i0 * 3 + 1], normals1[i0 * 3 + 2]);
      B.crossVectors(T, N);
      const ca = Math.cos(p.a), sa = Math.sin(p.a);
      tmp2.set(N.x * ca + B.x * sa, N.y * ca + B.y * sa, N.z * ca + B.z * sa);        // outward
      // cone axis: outward tilted slightly toward the tip
      N.copy(tmp2).addScaledVector(T, p.tilt).normalize();
      q4.setFromUnitVectors(up, N);
      tmp.addScaledVector(tmp2, r * 0.96);
      const dens = 1 - 0.55 * smoothstep(0.35, 1.0, i0 / NRING);          // fewer, smaller near the head
      sc.setScalar(p.size * dens);
      m4.compose(tmp, q4, sc);
      prickles.setMatrixAt(i, m4);
      shown++;
    }
    prickles.instanceMatrix.needsUpdate = true;

    // head anchor
    const k = NRING * 3;
    headAnchor.position.set(centers[k] + tangents[k] * 0.0, centers[k + 1], centers[k + 2]);
    T.set(tangents[k], tangents[k + 1], tangents[k + 2]);
    q4.setFromUnitVectors(up, T);
    headAnchor.quaternion.copy(q4);
    headAnchor.updateMatrixWorld(true);
    frame.headAxis.copy(T);
    frame.focus.copy(headAnchor.position).addScaledVector(T, 0.5);

    // ripples where the stalk pierces the surface
    if (rise > 0.02 && rise < 0.85 && t - lastRipple > 0.55) {
      for (let i = 0; i < NRING; i++) {
        if (centers[i * 3 + 1] <= 0 && centers[i * 3 + 4] > 0) {
          ctx.ripple(centers[i * 3], centers[i * 3 + 2], 0.9 * (1 - rise));
          break;
        }
      }
      lastRipple = t;
    }
  }

  function dispose() {
    geo.dispose(); mat.dispose(); prickGeo.dispose(); prickMat.dispose(); prickles.dispose();
  }
  return { group, headAnchor, update, dispose };
}
