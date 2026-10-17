/**
 * Pod - the lotus receptacle ("seed pod"): obconical body, slightly domed flat top with 19 carpel recesses holding
 * green seeds with pale stigmas (real geometry), a basal collar where petals/stamens/stalk meet, and 4-5 sepals that
 * clasp the bud and peel back as it opens.  Head local frame: origin = receptacle base, +Y = flower axis.
 */
import {
  Group, Mesh, BufferGeometry, BufferAttribute, Float32BufferAttribute, Uint32BufferAttribute, Uint16BufferAttribute, MeshStandardMaterial, MeshPhysicalMaterial,
  InstancedMesh, SphereGeometry, ConeGeometry, TorusGeometry, Matrix4, Vector3, Quaternion, Color, DoubleSide, Euler,
} from 'three';
import { FLOWER, PALETTE, coneRadius } from '../core/constants.js';
import { smoothstep, lerp, clamp01 } from '../core/timeline.js';

const R = FLOWER.receptacle;
const TAU = Math.PI * 2;

function carpelLayout(rng) {
  const out = [];
  R.carpelRingR.forEach((rr, ring) => {
    const n = R.carpelRingCount[ring];
    const off = rng.range(0, TAU);
    for (let i = 0; i < n; i++) {
      const a = off + (i / n) * TAU + rng.range(-0.07, 0.07);
      const rad = rr === 0 ? 0 : rr * rng.range(0.96, 1.04);
      out.push({ x: Math.cos(a) * rad, z: Math.sin(a) * rad, hr: R.carpelHoleR * rng.range(0.92, 1.1), depth: 0.05 * rng.range(0.85, 1.1) });
    }
  });
  return out;
}

/** height of the top surface at (x,z), plus a "hole-ness" 0..1 used for colouring */
function topHeight(x, z, carpels, out) {
  const r = Math.hypot(x, z);
  const t = Math.min(r / R.topR, 1);
  let h = R.height + R.domeH * (1 - t * t) - 0.006 * t * t;
  let hole = 0;
  let lip = 0;
  for (const c of carpels) {
    const d = Math.hypot(x - c.x, z - c.z) / c.hr;
    if (d < 1.6) {
      const bowl = 1 - smoothstep(0.55, 1.0, d);
      h -= c.depth * bowl;
      hole = Math.max(hole, bowl);
      const l = Math.exp(-Math.pow((d - 1.12) / 0.2, 2));
      h += 0.010 * l;
      lip = Math.max(lip, l);
    }
  }
  out.hole = hole;
  out.lip = lip;
  return h;
}

function buildBody(lod, carpels) {
  const Ns = Math.max(48, Math.round(128 * lod));
  const Nf = Math.max(10, Math.round(22 * lod));
  const Nr = Math.max(3, Math.round(6 * lod));
  const Nt = Math.max(24, Math.round(70 * lod));
  const rings = [];                       // each ring: array of {x,y,z, col}
  const cFlankLo = new Color(PALETTE.podSide).multiplyScalar(0.8);
  const cFlankHi = new Color(PALETTE.podSide);
  const cTop = new Color(PALETTE.podTop);
  const cHole = new Color(PALETTE.podSide).multiplyScalar(0.72);
  const cLip = new Color(PALETTE.podTop).lerp(new Color('#e6ecb0'), 0.35);
  const tmp = { hole: 0, lip: 0 };
  const pushRing = (fn) => {
    const ring = [];
    for (let i = 0; i <= Ns; i++) ring.push(fn((i / Ns) * TAU, i));
    rings.push(ring);
  };
  // flank: from y=-0.05 (hidden in the collar) up to the rim
  for (let j = 0; j <= Nf; j++) {
    const y = -0.05 + (R.height + 0.05) * (j / Nf);
    const rad = y < 0 ? R.baseR * (1 + y * 2) : coneRadius(y);
    const col = cFlankLo.clone().lerp(cFlankHi, clamp01(y / R.height));
    pushRing((a) => ({ x: Math.cos(a) * rad, y, z: Math.sin(a) * rad, c: col, ridge: Math.sin(a * 22) }));
  }
  // rim fillet (quarter circle, radius f)
  const f = 0.022;
  for (let j = 1; j <= Nr; j++) {
    const ang = (j / Nr) * (Math.PI / 2);
    const rad = R.topR - f + Math.sin(ang) * f;
    const y = R.height - f + Math.cos(ang) * f;
    const col = cFlankHi.clone().lerp(cTop, j / Nr);
    pushRing((a) => ({ x: Math.cos(a) * rad, y, z: Math.sin(a) * rad, c: col, ridge: 0 }));
  }
  // top disc, from rim inward to the centre (ring radius decreasing)
  for (let j = 1; j <= Nt; j++) {
    const rad = (R.topR - f) * (1 - j / Nt);
    pushRing((a) => {
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      const y = topHeight(x, z, carpels, tmp);
      const col = cTop.clone().lerp(cHole, tmp.hole * 0.85).lerp(cLip, tmp.lip * 0.5);
      return { x, y, z, c: col, ridge: 0 };
    });
  }
  const rows = rings.length;
  const cols = Ns + 1;
  const pos = new Float32Array(rows * cols * 3);
  const col = new Float32Array(rows * cols * 3);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const p = rings[j][i];
      const k = (j * cols + i) * 3;
      pos[k] = p.x; pos[k + 1] = p.y; pos[k + 2] = p.z;
      col[k] = p.c.r; col[k + 1] = p.c.g; col[k + 2] = p.c.b;
    }
  }
  const idx = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < Ns; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, b, c, b, d, c);   // outward-facing winding verified visually (flipped below if needed)
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setIndex(pos.length / 3 > 65535 ? new Uint32BufferAttribute(idx, 1) : new Uint16BufferAttribute(idx, 1));
  g.computeVertexNormals();
  // make sure normals point outward at the flank
  const ni = (Math.floor(Nf / 2) * cols) * 3;
  const nrm = g.getAttribute('normal');
  const px = pos[ni], pz = pos[ni + 2];
  if (nrm.getX(ni / 3) * px + nrm.getZ(ni / 3) * pz < 0) {
    const ix = g.index.array;
    for (let t = 0; t < ix.length; t += 3) { const tmpI = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = tmpI; }
    g.index.needsUpdate = true;
    g.computeVertexNormals();
  }
  return g;
}

// ---- sepals ---------------------------------------------------------------------------------------------------
const SEPAL_U = 14;
const SEPAL_S = 8;
function buildSepals(rng) {
  const n = 5;
  const list = [];
  const off = rng.range(0, TAU);
  for (let k = 0; k < n; k++) {
    list.push({
      phi: off + (k / n) * TAU + rng.range(-0.15, 0.15),
      L: rng.range(0.44, 0.56), W: rng.range(0.22, 0.30),
      t0c: rng.range(14, 24) * Math.PI / 180, t1c: rng.range(-4, 6) * Math.PI / 180,
      t0o: rng.range(95, 120) * Math.PI / 180, t1o: rng.range(130, 160) * Math.PI / 180,
      delay: rng.range(0, 0.08), twist: rng.range(-0.2, 0.2),
    });
  }
  const verts = list.length * (SEPAL_U + 1) * (SEPAL_S + 1);
  const pos = new Float32Array(verts * 3);
  const col = new Float32Array(verts * 3);
  const idx = [];
  const cg = new Color('#7fa04e'), cp = new Color('#d9708f'), ct = new Color('#b8885a');
  list.forEach((s, si) => {
    const base = si * (SEPAL_U + 1) * (SEPAL_S + 1);
    for (let i = 0; i <= SEPAL_U; i++) {
      const u = i / SEPAL_U;
      const c = cg.clone().lerp(cp, smoothstep(0.45, 1.0, u) * 0.75).lerp(ct, smoothstep(0.85, 1, u) * 0.5);
      for (let j = 0; j <= SEPAL_S; j++) {
        const k = (base + i * (SEPAL_S + 1) + j) * 3;
        col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
      }
    }
    for (let i = 0; i < SEPAL_U; i++) for (let j = 0; j < SEPAL_S; j++) {
      const a = base + i * (SEPAL_S + 1) + j, b = a + 1, c = a + SEPAL_S + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));      // shares `pos` (updated per frame)
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.setIndex(idx);
  return { list, geometry: g, pos };
}

function updateSepals(sp, bloom) {
  const { list, pos } = sp;
  let k = 0;
  for (const s of list) {
    const o = smoothstep(0.06 + s.delay, 0.72 + s.delay, bloom);
    const fall = 1 - smoothstep(0.40 + s.delay, 0.68 + s.delay, bloom);      // sepals drop away at anthesis
    const t0 = lerp(s.t0c, s.t0o, o), t1 = lerp(s.t1c, s.t1o, o);
    const cup = lerp(1.8, 0.6, o);
    const sp2 = Math.sin(s.phi), cp2 = Math.cos(s.phi);
    let r = 0.17, y = -0.05;
    const dl = s.L / SEPAL_U;
    for (let i = 0; i <= SEPAL_U; i++) {
      const u = i / SEPAL_U;
      const th = t0 + (t1 - t0) * Math.pow(u, 1.3);
      const hw = 0.5 * s.W * Math.pow(Math.max(Math.sin(Math.PI * Math.pow(u, 0.85)), 0), 0.75);
      const ca = Math.cos(th), sa = Math.sin(th);
      for (let j = 0; j <= SEPAL_S; j++) {
        const xn = (j / SEPAL_S) * 2 - 1;
        const x = xn * hw;
        const ob = Math.sin(cup * x) / (cup + 1e-4);
        const on = (1 - Math.cos(cup * x)) / (cup + 1e-4);
        const rad = r - ca * on - 0.012;      // slightly outside the outer petals' bases
        const ver = y + sa * on;
        // shrink toward the base while falling away
        const rr = 0.17 + (rad - 0.17) * fall, vv = -0.05 + (ver + 0.05) * fall - (1 - fall) * 0.3;
        pos[k++] = rr * sp2 + ob * cp2 * fall;
        pos[k++] = vv;
        pos[k++] = rr * cp2 - ob * sp2 * fall;
      }
      const um = (i + 0.5) / SEPAL_U;
      const thm = t0 + (t1 - t0) * Math.pow(um, 1.3);
      r += Math.sin(thm) * dl;
      y += Math.cos(thm) * dl;
    }
  }
}

/** @param {import('../main.js').Ctx} ctx */
export function createPod(ctx) {
  const lod = (ctx.quality && ctx.quality.lod) || 1;
  const rng = ctx.rng.fork('pod');
  const group = new Group();
  group.name = 'pod';

  const carpels = carpelLayout(rng);
  const bodyGeo = buildBody(lod, carpels);
  const bodyMat = new MeshPhysicalMaterial({ vertexColors: true, roughness: 0.52, metalness: 0, sheen: 0.4, sheenColor: new Color('#e8f0b0'), sheenRoughness: 0.6 });
  const body = new Mesh(bodyGeo, bodyMat);
  body.castShadow = true; body.receiveShadow = true;
  group.add(body);

  // seeds + stigmas (instanced)
  const seedGeo = new SphereGeometry(1, 16, 12);
  const seedMat = new MeshStandardMaterial({ color: '#b2cc52', roughness: 0.62 });
  const seeds = new InstancedMesh(seedGeo, seedMat, carpels.length);
  const stigGeo = new ConeGeometry(0.011, 0.03, 8, 1);
  const stigMat = new MeshStandardMaterial({ color: '#f3e47c', roughness: 0.55, emissive: '#3a3008', emissiveIntensity: 0.3 });
  const stigmas = new InstancedMesh(stigGeo, stigMat, carpels.length);
  const m = new Matrix4(), q = new Quaternion(), e = new Euler(), sc = new Vector3(), ps = new Vector3();
  const tmp = { hole: 0, lip: 0 };
  carpels.forEach((c, i) => {
    const top = topHeight(c.x, c.z, carpels, tmp);
    const rad = c.hr * 0.66;
    const bottom = top;                                  // surface height at the centre of the hole (recess floor)
    ps.set(c.x, bottom + rad * 0.55, c.z);
    sc.set(rad, rad * 1.18, rad);
    e.set(rng.range(-0.15, 0.15), rng.range(0, TAU), rng.range(-0.15, 0.15));
    q.setFromEuler(e);
    m.compose(ps, q, sc);
    seeds.setMatrixAt(i, m);
    const shade = rng.range(0.85, 1.1);
    seeds.setColorAt(i, new Color('#ffffff').multiplyScalar(shade));
    ps.set(c.x, bottom + rad * 0.55 + rad * 1.18 + 0.004, c.z);
    sc.set(1, 1, 1);
    q.identity();
    m.compose(ps, q, sc);
    stigmas.setMatrixAt(i, m);
  });
  seeds.castShadow = true; seeds.receiveShadow = true; stigmas.receiveShadow = true;
  group.add(seeds, stigmas);

  // collar where everything attaches
  const collarMat = new MeshStandardMaterial({ color: new Color(PALETTE.podSide).lerp(new Color('#d8e0a0'), 0.25), roughness: 0.6 });
  const collar = new Mesh(new TorusGeometry(0.135, 0.05, 14, 56), collarMat);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 0.0;
  collar.receiveShadow = true; collar.castShadow = true;
  group.add(collar);

  // sepals
  const sepals = buildSepals(rng);
  const sepalMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.55, side: DoubleSide });
  const sepalMesh = new Mesh(sepals.geometry, sepalMat);
  sepalMesh.frustumCulled = false; sepalMesh.castShadow = true; sepalMesh.receiveShadow = true;
  group.add(sepalMesh);
  let lastBloom = -1;
  function update(frame) {
    group.scale.setScalar(lerp(0.58, 1.0, smoothstep(0.04, 0.85, frame.bloom)));
    if (Math.abs(frame.bloom - lastBloom) > 1e-4) {
      updateSepals(sepals, frame.bloom);
      sepals.geometry.attributes.position.needsUpdate = true;
      sepals.geometry.computeVertexNormals();
      lastBloom = frame.bloom;
    }
  }
  update({ bloom: 0 });

  function dispose() {
    bodyGeo.dispose(); bodyMat.dispose(); seedGeo.dispose(); seedMat.dispose(); stigGeo.dispose(); stigMat.dispose();
    collar.geometry.dispose(); collarMat.dispose(); sepals.geometry.dispose(); sepalMat.dispose();
  }
  return { group, update, dispose };
}
