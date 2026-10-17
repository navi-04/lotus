/**
 * Stamens - hundreds of instanced filaments, each with a grooved golden anther and a small club-shaped appendage.
 * One shared tube geometry (rows along the stamen x radial segments); each instance bends along a clothoid-like arc
 * evaluated in the vertex stage (closed form for a linearly varying angle), driven by bloom and wind.
 * Head local frame (origin = receptacle base, +Y axis). Stamens attach on the cone flank and never enter it.
 */
import {
  Group, Mesh, InstancedBufferGeometry, InstancedBufferAttribute, BufferGeometry, Float32BufferAttribute, Uint16BufferAttribute,
  MeshPhysicalMaterial, MeshDepthMaterial, RGBADepthPacking, Color, DoubleSide,
} from 'three';
import { FLOWER, PALETTE, coneRadius } from '../core/constants.js';
import { smoothstep, lerp } from '../core/timeline.js';
import { addPatch, inject } from '../core/shaderPatch.js';

const D = Math.PI / 180;
const TAU = Math.PI * 2;

/** profile rows along the stamen: [t, radius, part] part 0 filament, 1 anther, 2 appendage */
function profile(rows) {
  const p = [];
  const nf = Math.max(3, Math.round(rows * 0.30));
  for (let i = 0; i <= nf; i++) { const t = (i / nf) * 0.70; p.push([t, 0.0068 - 0.0020 * (t / 0.7), 0]); }
  p.push([0.715, 0.0052, 0]);
  const na = Math.max(4, Math.round(rows * 0.42));
  for (let i = 0; i <= na; i++) {
    const s = i / na;
    const t = 0.72 + 0.24 * s;
    const r = 0.0150 * Math.pow(Math.max(Math.sin(Math.PI * Math.min(Math.max(s, 0.02), 0.98)), 0), 0.45);
    p.push([t, Math.max(r, 0.0030), 1]);
  }
  p.push([0.97, 0.0040, 2]);
  p.push([0.985, 0.0075, 2]);
  p.push([1.0, 0.0008, 2]);
  return p;
}

function buildGeometry(rows, radial) {
  const prof = profile(rows);
  const n = prof.length;
  const verts = n * (radial + 1);
  const T = new Float32Array(verts);
  const A = new Float32Array(verts);
  const Rr = new Float32Array(verts);
  const col = new Float32Array(verts * 3);
  const pos = new Float32Array(verts * 3);        // unused by the vertex stage (bounds only)
  const cF = new Color(PALETTE.filament), cA = new Color(PALETTE.anther), cT = new Color(PALETTE.antherTip);
  for (let i = 0; i < n; i++) {
    const [t, r, part] = prof[i];
    const c = part === 0 ? cF : part === 1 ? cA : cT;
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      const ang = (j / radial) * TAU;
      T[k] = t; A[k] = ang; Rr[k] = r;
      // anther groove: darker golden line on two opposite sides
      let g = 1;
      if (part === 1) g = 1 - 0.18 * Math.pow(Math.abs(Math.cos(ang * 2)), 6);
      col[k * 3] = c.r * g; col[k * 3 + 1] = c.g * g; col[k * 3 + 2] = c.b * g;
      pos[k * 3 + 1] = t * 0.5;
    }
  }
  const idx = [];
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < radial; j++) {
    const a = i * (radial + 1) + j, b = a + 1, c = a + radial + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const base = new BufferGeometry();
  base.setAttribute('position', new Float32BufferAttribute(pos, 3));
  base.setAttribute('aSt2', new Float32BufferAttribute(interleave(T, A, Rr), 3));
  base.setAttribute('color', new Float32BufferAttribute(col, 3));
  base.setIndex(new Uint16BufferAttribute(idx, 1));
  return base;
}
function interleave(a, b, c) {
  const out = new Float32Array(a.length * 3);
  for (let i = 0; i < a.length; i++) { out[i * 3] = a[i]; out[i * 3 + 1] = b[i]; out[i * 3 + 2] = c[i]; }
  return out;
}

const GLSL_DECL = /* glsl */ `
attribute vec4 aSt0;   // x azimuth, y attach radius, z attach height, w length
attribute vec4 aSt1;   // x tilt bud, y tilt open, z bend, w phase
attribute vec3 aSt2;   // x t along (0..1), y ring angle, z tube radius
attribute float aTint;
uniform float uBloom;
uniform float uTime;
uniform float uWindMag;

void stamenFrame(out vec3 P, out vec3 N) {
  float t = aSt2.x;
  float o = smoothstep(0.08, 0.95, uBloom);
  float tilt = mix(aSt1.x, aSt1.y, o);
  float len = aSt0.w * mix(0.80, 1.0, o);
  float sway = uWindMag * 0.20 * sin(uTime * 1.9 + aSt1.w) + 0.035 * sin(uTime * 0.9 + aSt1.w * 1.7);
  float bend = aSt1.z + sway;
  float bb = abs(bend) < 1e-3 ? (bend < 0.0 ? -1e-3 : 1e-3) : bend;
  float phi = tilt + bb * t;
  vec2 c = vec2(cos(tilt) - cos(tilt + bb * t), sin(tilt + bb * t) - sin(tilt)) / bb * len;
  vec3 N1 = vec3(cos(phi), -sin(phi), 0.0);
  vec3 ringN = cos(aSt2.y) * N1 + sin(aSt2.y) * vec3(0.0, 0.0, 1.0);
  vec3 loc = vec3(aSt0.y + c.x, aSt0.z + c.y, 0.0) + ringN * aSt2.z;
  float sp = sin(aSt0.x), cp = cos(aSt0.x);
  P = vec3(loc.x * sp + loc.z * cp, loc.y, loc.x * cp - loc.z * sp);
  N = vec3(ringN.x * sp + ringN.z * cp, ringN.y, ringN.x * cp - ringN.z * sp);
}
`;

/** @param {import('../main.js').Ctx} ctx */
export function createStamens(ctx) {
  const tier = ctx.quality.tier;
  const lod = ctx.quality.lod || 1;
  const count = FLOWER.stamens.count[tier] || 250;
  const rows = Math.max(8, Math.round(14 * Math.min(lod, 1.2)));
  const radial = tier === 'low' ? 4 : tier === 'medium' ? 5 : 6;
  const rng = ctx.rng.fork('stamens');

  const base = buildGeometry(rows, radial);
  const geo = new InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('aSt2', base.getAttribute('aSt2'));
  geo.setAttribute('color', base.getAttribute('color'));
  geo.instanceCount = count;

  const st0 = new Float32Array(count * 4);
  const st1 = new Float32Array(count * 4);
  const tint = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // 4 dense rings, outer ring the most populated
    const ring = rng.next();
    const band = ring < 0.12 ? 0 : ring < 0.30 ? 1 : ring < 0.58 ? 2 : 3;
    const ya = [0.15, 0.10, 0.06, 0.02][band] + rng.range(-0.015, 0.02);
    const ra = coneRadius(Math.max(ya, 0)) + 0.012 + rng.range(0.0, 0.03);
    const az = rng.range(0, TAU);
    const len = lerp(0.44, 0.66, Math.pow(rng.next(), 0.8)) * (band === 0 ? 0.9 : 1);
    const tiltBud = rng.range(28, 36) * D;
    const tiltOpen = rng.range(52, 74) * D + band * 0.02;
    const bend = rng.range(-0.55, -0.15);
    st0.set([az, ra, ya, len], i * 4);
    st1.set([tiltBud, tiltOpen, bend, rng.range(0, TAU)], i * 4);
    tint[i] = rng.range(0.86, 1.08);
  }
  geo.setAttribute('aSt0', new InstancedBufferAttribute(st0, 4));
  geo.setAttribute('aSt1', new InstancedBufferAttribute(st1, 4));
  geo.setAttribute('aTint', new InstancedBufferAttribute(tint, 1));
  geo.boundingSphere = null;

  const shared = {
    uBloom: { value: 0 },
    uTime: { value: 0 },
    uWindMag: { value: 0 },
  };

  const material = new MeshPhysicalMaterial({
    vertexColors: true, roughness: 0.5, metalness: 0, side: DoubleSide,
    sheen: 0.6, sheenColor: new Color('#fff0b0'), sheenRoughness: 0.5,
    emissive: new Color('#7a5408'), emissiveIntensity: 0.7,
  });
  addPatch(material, {
    key: `stamens-v1-${rows}-${radial}`,
    uniforms: shared,
    vertex: (v) => {
      v = inject(v, 'common', GLSL_DECL);
      v = inject(v, 'beginnormal_vertex', 'vec3 stP, stN; stamenFrame(stP, stN);', 'before');
      v = inject(v, 'beginnormal_vertex', 'objectNormal = stN;');
      v = inject(v, 'begin_vertex', 'transformed = stP;');
      v = inject(v, 'color_vertex', 'vColor.rgb *= aTint;');
      return v;
    },
  });
  const depthMat = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  addPatch(depthMat, {
    key: `stamens-depth-v1-${rows}-${radial}`,
    uniforms: shared,
    vertex: (v) => {
      v = inject(v, 'common', GLSL_DECL);
      v = inject(v, 'begin_vertex', 'vec3 stP, stN; stamenFrame(stP, stN); transformed = stP;');
      return v;
    },
  });

  const mesh = new Mesh(geo, material);
  mesh.name = 'stamens';
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.customDepthMaterial = depthMat;
  const group = new Group();
  group.name = 'stamens';
  group.add(mesh);

  function update(frame) {
    group.scale.setScalar(lerp(0.58, 1.0, smoothstep(0.04, 0.85, frame.bloom)));
    shared.uBloom.value = frame.bloom;
    shared.uTime.value = frame.time;
    shared.uWindMag.value = Math.min(1, Math.hypot(frame.wind.x, frame.wind.z));
  }
  function dispose() { geo.dispose(); base.dispose(); material.dispose(); depthMat.dispose(); }
  return { group, update, dispose };
}
