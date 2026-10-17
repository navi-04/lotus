/**
 * Leaves - floating lotus pads, emergent funnel leaves on prickly-green stalks, one furled young leaf, and the
 * lotus-effect water beads.  All leaf blades are ONE merged mesh: each leaf is a polar grid whose shape (bowl, upturned
 * rim, undulating margin, tilt, flutter, bob) is evaluated in the vertex stage from per-vertex leaf parameters.
 * Shading: glaucous blue-green wax bloom, radial veins with two levels of branching + fine reticulation (colour and
 * bump), paler matte underside, thin-lamina back-light glow, powdery sheen at grazing angles.
 */
import {
  Group, Mesh, BufferGeometry, Float32BufferAttribute, Uint16BufferAttribute, Uint32BufferAttribute, MeshPhysicalMaterial, MeshStandardMaterial,
  DoubleSide, Color, Vector3, Vector2, InstancedMesh, SphereGeometry, Matrix4, Quaternion, CatmullRomCurve3, TubeGeometry, LatheGeometry,
} from 'three';
import { PALETTE } from '../core/constants.js';
import { addPatch, inject } from '../core/shaderPatch.js';
import { smoothstep } from '../core/timeline.js';

const TAU = Math.PI * 2;

// ---- composition (units: 10 cm) ------------------------------------------------------------------------------------
const FLOATING = [
  { x: -3.0, z: 1.7, R: 1.85 }, { x: 3.1, z: 1.2, R: 1.6 }, { x: -5.6, z: -2.4, R: 2.7 }, { x: 5.4, z: -3.0, R: 2.3 },
  { x: 0.5, z: -5.6, R: 3.0 }, { x: -2.1, z: 4.1, R: 1.5 }, { x: 2.3, z: 3.7, R: 1.75 }, { x: -8.6, z: 1.6, R: 2.8 },
  { x: 8.2, z: 2.2, R: 2.5 }, { x: -0.5, z: -10.2, R: 3.3 }, { x: 6.8, z: -8.0, R: 3.0 }, { x: -7.0, z: -7.4, R: 2.9 },
];
const EMERGENT = [
  { x: -4.9, z: -4.6, R: 2.45, H: 2.9, tilt: 0.42, bowl: 0.30 },
  { x: 5.4, z: -5.4, R: 2.65, H: 3.3, tilt: 0.50, bowl: 0.34 },
  { x: -7.4, z: -0.6, R: 2.0, H: 1.9, tilt: 0.36, bowl: 0.26 },
  { x: 1.4, z: -9.8, R: 2.9, H: 3.9, tilt: 0.55, bowl: 0.30 },
];
const CAMERA_XZ = new Vector3(3.5, 0, 7.9);

// ---- shader snippets -----------------------------------------------------------------------------------------------
const VERT_DECL = /* glsl */ `
attribute vec2 aPolar;   // x = r/R (0 centre .. 1 margin), y = angle
attribute vec4 aL0;      // centre x, y, z, radius
attribute vec4 aL1;      // tilt azimuth, tilt amount, bowl, rim
attribute vec4 aL2;      // margin wave amp, wave phase, seed, kind (0 floating, 1 emergent)
uniform float uTime;
uniform vec2 uWind;
varying vec4 vLeaf;      // r~, theta, seed, kind
varying vec2 vLeafXZ;    // local planar position (for reticulation)

vec3 leafPoint(float rt, float th) {
  float R = aL0.w;
  float seed = aL2.z;
  float h = -0.012 * R * (1.0 - rt * rt);
  h += aL1.z * R * pow(rt, 2.1);
  h += aL1.w * R * smoothstep(0.60, 1.0, rt);
  float w = sin(th * 7.0 + aL2.y) * 0.55 + sin(th * 11.0 + aL2.y * 1.7) * 0.30 + sin(th * 4.0 + aL2.y * 0.6) * 0.40 + sin(th * 15.0 + seed * 31.0) * 0.12;
  float wv = aL2.w > 0.5 ? w : (w * 0.35 + 0.55);          // floating pads: waves only lift (never dip below the water)
  h += aL2.x * R * wv * pow(rt, 2.6);
  float wm = length(uWind);
  h += (0.008 + 0.022 * wm) * R * pow(rt, 3.0) * sin(th * 3.0 + uTime * 1.25 + seed * 30.0) * (aL2.w > 0.5 ? 1.6 : 1.0);
  float rr = R * rt * (1.0 + 0.05 * (sin(th * 6.0 + aL2.y) * 0.5 + sin(th * 9.0 + seed * 20.0) * 0.5) * smoothstep(0.65, 1.0, rt) + 0.07 * (sin(th * 3.0 + seed * 17.0) * 0.6 + sin(th * 2.0 + seed * 5.0) * 0.4) * smoothstep(0.35, 1.0, rt));
  vec3 p = vec3(cos(th) * rr, h, sin(th) * rr);
  // tilt: lean the leaf normal toward direction (sin az, cos az)
  float az = aL1.x, al = aL1.y;
  vec3 axis = vec3(cos(az), 0.0, -sin(az));
  float ca = cos(al), sa = sin(al);
  p = p * ca + cross(axis, p) * sa + axis * dot(axis, p) * (1.0 - ca);
  float bob = aL2.w > 0.5 ? 0.0 : 0.010 * sin(uTime * 0.8 + seed * 40.0);
  vec3 wp = aL0.xyz + p + vec3(0.0, bob, 0.0);
  if (aL2.w < 0.5) wp.y = max(wp.y, 0.025);             // a floating pad rests on the water: it never dips below it
  return wp;
}
`;

const VERT_MAIN = /* glsl */ `
  float lrt = aPolar.x, lth = aPolar.y;
  vec3 leafP = leafPoint(lrt, lth);
  float e1 = 0.012, e2 = 0.02;
  vec3 dR = leafPoint(min(lrt + e1, 1.0), lth) - leafPoint(max(lrt - e1, 0.0), lth);
  vec3 dT = leafPoint(lrt, lth + e2) - leafPoint(lrt, lth - e2);
  vec3 leafN = cross(dT, dR);
  float lnl = length(leafN);
  leafN = lnl > 1e-8 ? leafN / lnl : vec3(0.0, 1.0, 0.0);
  if (leafN.y < 0.0 && aL1.y < 1.2) leafN = -leafN;
  vLeaf = vec4(lrt, lth, aL2.z, aL2.w);
  vLeafXZ = vec2(cos(lth), sin(lth)) * aL0.w * lrt;
`;

const FRAG_PARS = /* glsl */ `
varying vec4 vLeaf;
varying vec2 vLeafXZ;
uniform vec3 uLTop; uniform vec3 uLTop2; uniform vec3 uLBloom; uniform vec3 uLVein; uniform vec3 uLUnder;

vec3 gLTrans = vec3(0.0);
float gLVein = 0.0;
float gLAO = 1.0;

float lH21(vec2 p) { vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float lVN(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(lH21(i), lH21(i + vec2(1., 0.)), f.x), mix(lH21(i + vec2(0., 1.)), lH21(i + vec2(1., 1.)), f.x), f.y);
}
float lFBM3(vec2 p) { float a = .5, s = 0.; for (int i = 0; i < 3; i++) { s += a * lVN(p); p = p * 2.03 + 17.17; a *= .5; } return s; }
float lLine(float x, float w) {
  float d = abs(fract(x + 0.5) - 0.5);
  return 1.0 - smoothstep(w, w + fwidth(x) * 1.4 + 0.015, d);
}
// radial veins: 22 primaries, forking twice outward, with slight meander; plus a faint cell-like reticulation
float leafVeins(float rt, float th, float seed, vec2 xz) {
  float N = 22.0;
  float a = th / 6.2831853 * N + (lVN(vec2(rt * 3.0, th * 1.5 + seed * 9.0)) - 0.5) * 0.14 * rt;
  float v1 = lLine(a, mix(0.045, 0.020, rt));
  float v2 = lLine(a * 2.0 + 0.5, 0.030) * smoothstep(0.30, 0.42, rt) * 0.8;
  float v3 = lLine(a * 4.0 + 0.25, 0.026) * smoothstep(0.58, 0.70, rt) * 0.6;
  float ret = 1.0 - smoothstep(0.0, 0.11, abs(lVN(xz * 21.0) - 0.5));
  return clamp(max(max(v1, v2), v3) * smoothstep(0.02, 0.10, rt) + ret * 0.20 * smoothstep(0.05, 0.3, rt), 0.0, 1.0);
}
vec3 lToLin(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
`;

const FRAG_SURFACE = /* glsl */ `
{
  float rt = vLeaf.x, th = vLeaf.y, seed = vLeaf.z;
  float vein = leafVeins(rt, th, seed, vLeafXZ);
  gLVein = vein;
  float n1 = lFBM3(vLeafXZ * 1.7 + seed * 13.0);
  float n2 = lVN(vLeafXZ * 9.0 + seed * 3.0);
  vec3 top = mix(uLTop, uLTop2, n1);
  // waxy bloom: whitish-blue haze strongest in the centre and on raised areas, fading to the margin
  float bloom = (0.18 + 0.55 * smoothstep(1.0, 0.0, rt)) * (0.5 + 0.7 * n2);
  top = mix(top, uLBloom, clamp(bloom * 0.45, 0.0, 0.7));
  top = mix(top, uLVein, vein * 0.38);
  top = mix(top, uLBloom, 0.35 * smoothstep(0.10, 0.0, rt));
  if (rt > 0.86) {   // dry brown nicks along the margin
    float dry = smoothstep(0.90, 1.0, rt) * smoothstep(0.55, 0.85, lVN(vec2(th * 3.0 + seed * 20.0, rt * 4.0)));
    top = mix(top, vec3(0.50, 0.42, 0.20), dry * 0.7);
  }
  vec3 under = mix(uLUnder, uLVein, vein * 0.6);
  vec3 albS = gl_FrontFacing ? top : under;
  diffuseColor.rgb = lToLin(albS);
  gLTrans = lToLin(mix(uLTop, vec3(0.55, 0.72, 0.18), 0.5)) * 0.50;
  gLAO = 0.82 + 0.18 * smoothstep(0.0, 0.35, rt);
}
`;

const FRAG_ROUGH = /* glsl */ `
roughnessFactor = clamp(roughnessFactor + (gLVein - 0.3) * 0.12, 0.35, 0.85);
`;

const FRAG_BUMP = /* glsl */ `
{
  vec2 dH = vec2(dFdx(gLVein), dFdy(gLVein)) * 0.006;
  vec3 sX = normalize(dFdx(- vViewPosition)), sY = normalize(dFdy(- vViewPosition));
  vec3 R1 = cross(sY, normal), R2 = cross(normal, sX);
  float det = dot(sX, R1) * faceDirection;
  vec3 grad = sign(det) * (dH.x * R1 + dH.y * R2);
  normal = normalize(abs(det) * normal - grad);
}
`;

const FRAG_RE_DIRECT = /* glsl */ `
void RE_Direct_Leaf( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  float NL = dot( geometryNormal, directLight.direction );
  // thin lamina: light arriving from behind glows through, tinted yellow-green
  reflectedLight.directDiffuse += directLight.color * gLTrans * RECIPROCAL_PI * saturate( - NL );
  // soft wrap on the lit side
  float wrapD = saturate( ( NL + 0.25 ) / 1.25 ) - saturate( NL );
  reflectedLight.directDiffuse += directLight.color * material.diffuseContribution * ( wrapD * RECIPROCAL_PI );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Leaf
`;

const FRAG_INDIRECT = /* glsl */ `
{
  vec3 irrBack = vec3( 0.0 );
  #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
    irrBack += getIBLIrradiance( - geometryNormal ) * RECIPROCAL_PI;
  #endif
  reflectedLight.indirectDiffuse += irrBack * gLTrans * 0.8;
  reflectedLight.indirectDiffuse *= gLAO;
}
`;

// ---- geometry helpers ----------------------------------------------------------------------------------------------
/** CPU twin of leafPoint (no flutter / bob) for placing droplets */
function leafPointJS(L, rt, th, out) {
  const R = L.R;
  let h = -0.012 * R * (1 - rt * rt) + L.bowl * R * Math.pow(rt, 2.1) + L.rim * R * smoothstep(0.60, 1.0, rt);
  const w = Math.sin(th * 7 + L.wph) * 0.55 + Math.sin(th * 11 + L.wph * 1.7) * 0.30 + Math.sin(th * 4 + L.wph * 0.6) * 0.40 + Math.sin(th * 15 + L.seed * 31) * 0.12;
  h += L.wamp * R * (L.kind > 0.5 ? w : w * 0.35 + 0.55) * Math.pow(rt, 2.6);
  const rr = R * rt * (1 + 0.05 * (Math.sin(th * 6 + L.wph) * 0.5 + Math.sin(th * 9 + L.seed * 20) * 0.5) * smoothstep(0.65, 1.0, rt) + 0.07 * (Math.sin(th * 3 + L.seed * 17) * 0.6 + Math.sin(th * 2 + L.seed * 5) * 0.4) * smoothstep(0.35, 1.0, rt));
  let x = Math.cos(th) * rr, y = h, z = Math.sin(th) * rr;
  const az = L.tAz, al = L.tilt;
  const ax = Math.cos(az), az2 = -Math.sin(az);                       // axis (ax, 0, az2)
  const ca = Math.cos(al), sa = Math.sin(al);
  const crx = -az2 * y, cry = az2 * x - ax * z, crz = ax * y;
  const dotap = ax * x + az2 * z;
  const px = x * ca + crx * sa + ax * dotap * (1 - ca);
  const py = y * ca + cry * sa;
  const pz = z * ca + crz * sa + az2 * dotap * (1 - ca);
  return out.set(L.x + px, L.y + py, L.z + pz);
}

function buildLeafGeometry(leaves, nr, na) {
  const per = (nr + 1) * (na + 1);
  const nVert = per * leaves.length;
  const pos = new Float32Array(nVert * 3);
  const polar = new Float32Array(nVert * 2);
  const l0 = new Float32Array(nVert * 4), l1 = new Float32Array(nVert * 4), l2 = new Float32Array(nVert * 4);
  const nrm = new Float32Array(nVert * 3);
  const idx = nVert > 65535 ? new Uint32Array(leaves.length * nr * na * 6) : new Uint16Array(leaves.length * nr * na * 6);
  let ii = 0;
  leaves.forEach((L, li) => {
    for (let i = 0; i <= nr; i++) {
      // denser rings toward the margin where the undulation lives
      const rt = Math.pow(i / nr, 0.85);
      for (let j = 0; j <= na; j++) {
        const th = (j / na) * TAU;
        const k = li * per + i * (na + 1) + j;
        pos[k * 3] = L.x + Math.cos(th) * L.R * rt; pos[k * 3 + 1] = L.y; pos[k * 3 + 2] = L.z + Math.sin(th) * L.R * rt;
        nrm[k * 3 + 1] = 1;
        polar[k * 2] = rt; polar[k * 2 + 1] = th;
        l0.set([L.x, L.y, L.z, L.R], k * 4);
        l1.set([L.tAz, L.tilt, L.bowl, L.rim], k * 4);
        l2.set([L.wamp, L.wph, L.seed, L.kind], k * 4);
      }
    }
    const base = li * per;
    for (let i = 0; i < nr; i++) for (let j = 0; j < na; j++) {
      const a = base + i * (na + 1) + j, b = a + 1, c = a + na + 1, d = c + 1;
      idx[ii++] = a; idx[ii++] = b; idx[ii++] = c; idx[ii++] = b; idx[ii++] = d; idx[ii++] = c;
    }
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  g.setAttribute('aPolar', new Float32BufferAttribute(polar, 2));
  g.setAttribute('aL0', new Float32BufferAttribute(l0, 4));
  g.setAttribute('aL1', new Float32BufferAttribute(l1, 4));
  g.setAttribute('aL2', new Float32BufferAttribute(l2, 4));
  g.setIndex(nVert > 65535 ? new Uint32BufferAttribute(idx, 1) : new Uint16BufferAttribute(idx, 1));
  return g;
}

/** @param {import('../main.js').Ctx} ctx */
export function createLeaves(ctx) {
  const tier = ctx.quality.tier;
  const lod = ctx.quality.lod || 1;
  const rng = ctx.rng.fork('leaves');
  const NR = Math.max(10, Math.round(22 * lod));
  const NA = Math.max(32, Math.round(88 * lod));
  const group = new Group();
  group.name = 'leaves';

  // ---- leaf descriptors ------------------------------------------------------------------------------------------
  const leaves = [];
  for (const f of FLOATING) {
    leaves.push({
      x: f.x, y: 0.05, z: f.z, R: f.R, kind: 0, seed: rng.next(), wph: rng.range(0, TAU),
      wamp: rng.range(0.025, 0.05), rim: rng.range(0.0, 0.05), bowl: rng.range(0.0, 0.03),
      tAz: rng.range(0, TAU), tilt: rng.range(0.0, 0.02),
    });
    ctx.pondLayout.leafDisks.push({ x: f.x, z: f.z, r: f.R });
  }
  for (const e of EMERGENT) {
    const az = Math.atan2(CAMERA_XZ.x - e.x, CAMERA_XZ.z - e.z);
    leaves.push({
      x: e.x, y: e.H, z: e.z, R: e.R, kind: 1, seed: rng.next(), wph: rng.range(0, TAU),
      wamp: rng.range(0.05, 0.09), rim: rng.range(0.0, 0.05), bowl: e.bowl,
      tAz: az + rng.range(-0.3, 0.3), tilt: e.tilt + rng.range(-0.08, 0.08),
    });
  }

  const geo = buildLeafGeometry(leaves, NR, NA);
  geo.boundingSphere = null;

  const material = new MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.55, metalness: 0, side: DoubleSide,
    sheen: tier === 'low' || tier === 'medium' ? 0.0 : 0.30, sheenColor: new Color('#cfe4d8'), sheenRoughness: 0.6, specularIntensity: 0.16,
  });
  const U = {
    uTime: { value: 0 },
    uWind: { value: new Vector2(0, 0) },
    uLTop: { value: srgb('#3f8a5e') },
    uLTop2: { value: srgb('#336f4e') },
    uLBloom: { value: srgb(PALETTE.leafBloom) },
    uLVein: { value: srgb(PALETTE.leafVein) },
    uLUnder: { value: srgb(PALETTE.leafUnder) },
  };
  const full = tier !== 'low';
  addPatch(material, {
    key: `leaf-v1-${full ? 'F' : 'L'}`,
    uniforms: U,
    vertex: (v) => {
      v = inject(v, 'common', VERT_DECL);
      v = inject(v, 'beginnormal_vertex', VERT_MAIN, 'before');
      v = inject(v, 'beginnormal_vertex', 'objectNormal = leafN;');
      v = inject(v, 'begin_vertex', 'transformed = leafP;');
      return v;
    },
    fragment: (f) => {
      f = inject(f, 'lights_physical_pars_fragment', FRAG_PARS + FRAG_RE_DIRECT);
      f = inject(f, 'map_fragment', FRAG_SURFACE);
      f = inject(f, 'roughnessmap_fragment', FRAG_ROUGH);
      if (full) f = inject(f, 'normal_fragment_maps', FRAG_BUMP);
      f = inject(f, 'lights_fragment_end', FRAG_INDIRECT);
      return f;
    },
  });
  const stalkMat = new MeshStandardMaterial({ color: PALETTE.stem, roughness: 0.6 });
  const blades = new Mesh(geo, material);
  blades.frustumCulled = false;
  blades.name = 'leaf-blades';
  group.add(blades);

  // ---- far field: a pond full of pads (low-detail, same shader) + a few distant pink buds ---------------------------
  const farRng = ctx.rng.fork('farpond');
  const farLeaves = [];
  const farCount = { low: 22, medium: 38, high: 56, ultra: 72 }[tier] || 40;
  const placed = leaves.map((l) => ({ x: l.x, z: l.z, r: l.R }));
  for (let i = 0; i < farCount; i++) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const a = farRng.range(0, TAU);
      const d = 12 + Math.pow(farRng.next(), 0.75) * 66;
      const R = farRng.range(1.7, 3.4) * (0.85 + d / 90);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < (p.r + R) * 0.8)) continue;
      placed.push({ x, z, r: R });
      farLeaves.push({
        x, y: 0.05, z, R, kind: 0, seed: farRng.next(), wph: farRng.range(0, TAU),
        wamp: farRng.range(0.03, 0.06), rim: farRng.range(0.0, 0.06), bowl: farRng.range(0.0, 0.03),
        tAz: farRng.range(0, TAU), tilt: farRng.range(0.0, 0.02),
      });
      break;
    }
  }
  const farGeo = buildLeafGeometry(farLeaves, 8, 40);
  farGeo.boundingSphere = null;
  const farBlades = new Mesh(farGeo, material);
  farBlades.frustumCulled = false;
  farBlades.name = 'leaf-blades-far';
  group.add(farBlades);

  // distant buds on thin stalks (low-poly ogive, pink-to-cream gradient)
  const budProfile = [[0.001, 0], [0.12, 0.05], [0.25, 0.30], [0.33, 0.62], [0.29, 0.95], [0.15, 1.22], [0.001, 1.40]].map(([r, y]) => new Vector2(r, y));
  const budGeo = new LatheGeometry(budProfile, 14);
  {
    const pos = budGeo.getAttribute('position');
    const col = new Float32Array(pos.count * 3);
    const cBase = new Color('#e9ecc4'), cMid = new Color('#f4c4d4'), cTip = new Color('#e0488a'), tmpC = new Color();
    for (let i = 0; i < pos.count; i++) {
      const t = Math.min(Math.max(pos.getY(i) / 1.4, 0), 1);
      tmpC.copy(cBase).lerp(cMid, smoothstep(0.1, 0.5, t)).lerp(cTip, smoothstep(0.45, 0.95, t));
      col.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
    }
    budGeo.setAttribute('color', new Float32BufferAttribute(col, 3));
  }
  const budMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.55, emissive: '#5a1630', emissiveIntensity: 0.18 });
  const nBuds = tier === 'low' ? 3 : 7;
  const budStalkGeos = [];
  for (let i = 0; i < nBuds; i++) {
    const a = farRng.range(0, TAU), d = farRng.range(11, 46);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < p.r * 0.7 + 0.5)) continue;
    const H = farRng.range(2.4, 4.6), sc = farRng.range(0.8, 1.15), tilt = farRng.range(-0.25, 0.25);
    const bud = new Mesh(budGeo, budMat);
    bud.position.set(x, H, z);
    bud.scale.setScalar(sc);
    bud.rotation.set(tilt, farRng.range(0, TAU), farRng.range(-0.2, 0.2));
    group.add(bud);
    const g = new TubeGeometry(new CatmullRomCurve3([new Vector3(x, -0.6, z), new Vector3(x + tilt * 0.6, H * 0.5, z - tilt * 0.4), new Vector3(x, H - 0.05, z)]), 12, 0.05, 6, false);
    budStalkGeos.push(g);
    group.add(new Mesh(g, stalkMat));
    placed.push({ x, z, r: 0.6 });
  }

  // ---- stalks of the emergent leaves (+ a furled young leaf) ----------------------------------------------------
  const stalkGeos = [];
  for (const L of leaves) {
    if (L.kind !== 1) continue;
    const lean = new Vector3(rng.range(-0.3, 0.3), 0, rng.range(-0.3, 0.3));
    const curve = new CatmullRomCurve3([
      new Vector3(L.x + lean.x * 0.2, -1.0, L.z + lean.z * 0.2),
      new Vector3(L.x + lean.x, L.y * 0.4, L.z + lean.z),
      new Vector3(L.x + lean.x * 0.4, L.y * 0.8, L.z + lean.z * 0.4),
      new Vector3(L.x, L.y - 0.02, L.z),
    ]);
    const g = new TubeGeometry(curve, 28, 0.05, 8, false);
    stalkGeos.push(g);
    const m = new Mesh(g, stalkMat);
    m.castShadow = false;
    group.add(m);
  }
  // furled young leaf: a green scroll rising from the water
  {
    const x = 1.9, z = -2.4, Hh = 1.25;
    const g = new TubeGeometry(new CatmullRomCurve3([new Vector3(x, -0.6, z), new Vector3(x + 0.05, Hh * 0.5, z), new Vector3(x + 0.1, Hh, z + 0.03)]), 24, 0.16, 10, false);
    // taper toward the tip
    const p = g.getAttribute('position');
    const curve0 = new Vector3();
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      const t = Math.min(Math.max((y + 0.6) / (Hh + 0.6), 0), 1);
      const s = t < 0.55 ? 0.30 : 1.0 - 0.9 * smoothstep(0.75, 1.0, t);
      curve0.set(x + 0.05 * t, 0, z);
      p.setX(i, curve0.x + (p.getX(i) - curve0.x) * s);
      p.setZ(i, curve0.z + (p.getZ(i) - curve0.z) * s);
    }
    g.computeVertexNormals();
    stalkGeos.push(g);
    const scrollMat = new MeshStandardMaterial({ color: '#8fb868', roughness: 0.5 });
    group.add(new Mesh(g, scrollMat));
    stalkGeos.push(scrollMat);
  }

  // ---- lotus-effect water beads ------------------------------------------------------------------------------------
  const beads = [];
  const tmpP = new Vector3(), tmpA = new Vector3(), tmpB = new Vector3();
  leaves.forEach((L) => {
    const n = Math.round((L.kind === 1 ? 7 : 5) + L.R * (L.kind === 1 ? 7 : 4)) * (tier === 'low' ? 0.5 : 1);
    for (let i = 0; i < n; i++) {
      const rt = Math.pow(rng.next(), 1.5) * 0.88 + 0.03;
      const th = rng.range(0, TAU);
      leafPointJS(L, rt, th, tmpP);
      leafPointJS(L, Math.min(rt + 0.015, 1), th, tmpA);
      leafPointJS(L, rt, th + 0.02, tmpB);
      tmpA.sub(tmpP); tmpB.sub(tmpP);
      const nrm = tmpB.clone().cross(tmpA).normalize();
      if (nrm.y < 0) nrm.negate();
      const r = 0.012 + Math.pow(rng.next(), 2.2) * 0.075;
      beads.push({ p: tmpP.clone().addScaledVector(nrm, r * 0.62), n: nrm, r });
    }
  });
  const beadGeo = new SphereGeometry(1, 20, 14);
  const beadMat = new MeshPhysicalMaterial({
    color: '#8fb8a0', roughness: 0.02, metalness: 0.0, ior: 1.33, specularIntensity: 1.0, clearcoat: 1.0, clearcoatRoughness: 0.02, envMapIntensity: 2.4, emissive: '#10281c', emissiveIntensity: 0.6,
  });
  const bead = new InstancedMesh(beadGeo, beadMat, beads.length);
  const mtx = new Matrix4(), qq = new Quaternion(), sc = new Vector3();
  const up = new Vector3(0, 1, 0);
  beads.forEach((b, i) => {
    qq.setFromUnitVectors(up, b.n);
    sc.set(b.r, b.r * 0.82, b.r);
    mtx.compose(b.p, qq, sc);
    bead.setMatrixAt(i, mtx);
  });
  bead.castShadow = false;
  group.add(bead);

  function update(frame) {
    U.uTime.value = frame.time;
    U.uWind.value.set(frame.wind.x, frame.wind.z);
  }
  function dispose() {
    geo.dispose(); farGeo.dispose(); budGeo.dispose(); budMat.dispose(); material.dispose(); stalkMat.dispose(); beadGeo.dispose(); beadMat.dispose(); bead.dispose();
    for (const g of stalkGeos) g.dispose();
    for (const g of budStalkGeos) g.dispose();
  }
  return { group, update, dispose, leaves };
}

function srgb(hex) {
  const c = new Color(hex);
  const o = { r: 0, g: 0, b: 0 };
  c.getRGB(o, 'srgb');
  return new Vector3(o.r, o.g, o.b);
}
