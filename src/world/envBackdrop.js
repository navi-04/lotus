/**
 * Backdrop - everything that makes the air look like dawn over a pond:
 *   - two layers of distant tree-line silhouettes melting into the haze
 *   - large soft bokeh discs (out-of-focus lights) all around, slowly twinkling
 *   - sunlit dust / pollen motes drifting through the air near the flower
 * All procedural, deterministic from `frame.time`, no textures.
 */
import {
  Group, Mesh, CylinderGeometry, ShaderMaterial, BackSide, AdditiveBlending, Color, Vector2,
  InstancedBufferGeometry, InstancedBufferAttribute, BufferGeometry, Float32BufferAttribute, Points,
} from 'three';
import { GLSL_NOISE_LITE } from '../core/noiseLite.js';
import { SCENE } from '../core/constants.js';

const TAU = Math.PI * 2;

// ---- tree line ---------------------------------------------------------------------------------------------------
const TREE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const TREE_FRAG = /* glsl */ `
${GLSL_NOISE_LITE}
varying vec2 vUv;
uniform vec3 uCol;
uniform vec3 uHaze;
uniform float uSeed;
uniform float uTop;       // typical top height as a fraction of the cylinder
uniform float uMist;      // how much haze sits in front
void main() {
  float a = vUv.x * 6.2831853;
  vec2 c = vec2(cos(a), sin(a));
  float n = pnoise(c * 3.0 + uSeed) * 0.5
          + pnoise(c * 9.0 + uSeed * 2.0) * 0.28
          + pnoise(c * 27.0 + uSeed * 3.0) * 0.14
          + pnoise(c * 70.0 + uSeed * 4.0) * 0.06;
  float top = uTop * (0.62 + 0.55 * (n + 0.5));
  float y = vUv.y;
  float alpha = 1.0 - smoothstep(top - 0.012, top + 0.004, y);
  float haze = clamp(uMist + (1.0 - y / max(top, 0.01)) * 0.35, 0.0, 1.0);
  vec3 col = mix(uCol, uHaze, haze);
  if (alpha < 0.5) discard;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function treeLayer({ radius, height, color, haze, seed, top, mist }) {
  const geo = new CylinderGeometry(radius, radius, height, 128, 1, true);
  geo.translate(0, height * 0.5 - 2.0, 0);
  const mat = new ShaderMaterial({
    side: BackSide, transparent: false, depthWrite: false, depthTest: false, fog: false,
    uniforms: { uCol: { value: new Color(color) }, uHaze: { value: new Color(haze) }, uSeed: { value: seed }, uTop: { value: top }, uMist: { value: mist } },
    vertexShader: TREE_VERT, fragmentShader: TREE_FRAG,
  });
  const m = new Mesh(geo, mat);
  m.frustumCulled = false;
  return m;
}

// ---- bokeh discs ---------------------------------------------------------------------------------------------------
const BOKEH_VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aData;     // size, phase, hue seed, brightness
varying vec2 vQ;
varying vec4 vData;
uniform float uTime;
void main() {
  vQ = position.xy;
  vData = aData;
  vec4 mv = viewMatrix * vec4(aPos, 1.0);
  float tw = 0.85 + 0.15 * sin(uTime * 0.6 + aData.y * 20.0);
  mv.xy += position.xy * aData.x * tw;
  gl_Position = projectionMatrix * mv;
}
`;
const BOKEH_FRAG = /* glsl */ `
varying vec2 vQ;
varying vec4 vData;
uniform float uTime;
void main() {
  float d = length(vQ);
  if (d > 1.0) discard;
  float edge = smoothstep(0.75, 0.98, d);
  float disc = (1.0 - smoothstep(0.80, 1.0, d)) * (0.75 + 0.25 * edge);
  vec3 warm = vec3(1.0, 0.82, 0.52);
  vec3 pink = vec3(1.0, 0.62, 0.62);
  vec3 grn = vec3(0.78, 0.95, 0.60);
  vec3 col = vData.z < 0.55 ? mix(warm, pink, vData.z / 0.55) : mix(warm, grn, (vData.z - 0.55) / 0.45);
  float tw = 0.8 + 0.2 * sin(uTime * 0.5 + vData.y * 31.0);
  gl_FragColor = vec4(col * vData.w * tw, disc);
}
`;

// ---- dust / pollen motes --------------------------------------------------------------------------------------------
const MOTE_VERT = /* glsl */ `
attribute vec4 aSeed;     // x phase, y radius frac, z height frac, w size
uniform float uTime;
uniform vec3 uFocus;
uniform vec3 uSun;
uniform vec2 uWind;
uniform float uPixelScale;
varying float vA;
void main() {
  float t = uTime * 0.07 + aSeed.x * 9.0;
  float ang = aSeed.x * 6.2831853 + t * 0.35;
  float rad = 0.8 + aSeed.y * 6.5;
  float hgt = fract(aSeed.z + t * 0.06) ;                  // slow upward drift, wraps
  vec3 p = uFocus + vec3(cos(ang) * rad + uWind.x * hgt * 1.5, -2.8 + hgt * 9.0, sin(ang) * rad + uWind.y * hgt * 1.5);
  p.x += sin(uTime * 0.4 + aSeed.x * 40.0) * 0.12;
  p.z += cos(uTime * 0.33 + aSeed.x * 33.0) * 0.12;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = -mv.z;
  // forward-scatter glow when looking toward the sun
  vec3 V = normalize(p - cameraPosition);
  float fs = pow(max(dot(V, uSun), 0.0), 6.0);
  float fadeY = smoothstep(0.0, 0.08, hgt) * (1.0 - smoothstep(0.75, 1.0, hgt));
  vA = (0.25 + 1.1 * fs) * fadeY * smoothstep(0.6, 2.5, dist);
  gl_PointSize = clamp(aSeed.w * 0.03 * uPixelScale / max(dist, 0.5), 1.0, 16.0);
}
`;
const MOTE_FRAG = /* glsl */ `
varying float vA;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d = dot(q, q);
  if (d > 1.0) discard;
  float a = (1.0 - d) * (1.0 - d) * vA;
  gl_FragColor = vec4(vec3(1.0, 0.86, 0.6) * 1.6, a);
}
`;

/** @param {import('../main.js').Ctx} ctx */
export function createBackdrop(ctx) {
  const rng = ctx.rng.fork('backdrop');
  const q = ctx.quality;
  const group = new Group();
  group.name = 'backdrop';
  const disposables = [];

  // tree lines (far first)
  const far = treeLayer({ radius: 175, height: 40, color: '#8d939c', haze: '#ecd5bf', seed: 3.7, top: 0.24, mist: 0.62 });
  const near = treeLayer({ radius: 125, height: 34, color: '#55656a', haze: '#e4cdb9', seed: 11.3, top: 0.19, mist: 0.46 });
  far.renderOrder = -950; near.renderOrder = -940;
  group.add(far, near);
  disposables.push(far, near);

  // bokeh
  const nB = Math.round(46 * q.particles);
  if (nB > 0) {
    const quad = new InstancedBufferGeometry();
    quad.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    const pos = new Float32Array(nB * 3), dat = new Float32Array(nB * 4);
    for (let i = 0; i < nB; i++) {
      const a = rng.range(0, TAU);
      const r = rng.range(55, 130);
      pos.set([Math.cos(a) * r, rng.range(1.5, 22), Math.sin(a) * r], i * 3);
      const size = Math.pow(rng.next(), 2.2) * 1.9 + 0.6;
      dat.set([size, rng.next(), rng.next(), rng.range(0.04, 0.16) * (size > 1.6 ? 0.7 : 1)], i * 4);
    }
    quad.setAttribute('aPos', new InstancedBufferAttribute(pos, 3));
    quad.setAttribute('aData', new InstancedBufferAttribute(dat, 4));
    quad.instanceCount = nB;
    const mat = new ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true, blending: AdditiveBlending, fog: false,
      uniforms: { uTime: { value: 0 } }, vertexShader: BOKEH_VERT, fragmentShader: BOKEH_FRAG,
    });
    const mesh = new Mesh(quad, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -800;
    group.add(mesh);
    disposables.push(mesh);
    group.userData.bokeh = mat;
  }

  // motes
  const nM = Math.round(220 * q.particles);
  let moteMat = null;
  const sizeTmp = new Vector2();
  if (nM > 0) {
    const g = new BufferGeometry();
    const seed = new Float32Array(nM * 4);
    for (let i = 0; i < nM; i++) seed.set([rng.next(), Math.pow(rng.next(), 0.7), rng.next(), rng.range(0.6, 1.6)], i * 4);
    g.setAttribute('position', new Float32BufferAttribute(new Float32Array(nM * 3), 3));
    g.setAttribute('aSeed', new Float32BufferAttribute(seed, 4));
    moteMat = new ShaderMaterial({
      transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false,
      uniforms: { uTime: { value: 0 }, uFocus: { value: ctx.frame.focus }, uSun: { value: ctx.sun.direction }, uWind: { value: new Vector2() }, uPixelScale: { value: 60 } },
      vertexShader: MOTE_VERT, fragmentShader: MOTE_FRAG,
    });
    const pts = new Points(g, moteMat);
    pts.frustumCulled = false;
    pts.renderOrder = 20;
    group.add(pts);
    disposables.push(pts);
  }

  function update(frame) {
    const cam = frame.camera;
    if (cam) { far.position.copy(cam.position); far.position.y = 0; near.position.copy(cam.position); near.position.y = 0; }
    if (group.userData.bokeh) group.userData.bokeh.uniforms.uTime.value = frame.time;
    if (moteMat) {
      moteMat.uniforms.uTime.value = frame.time;
      moteMat.uniforms.uWind.value.set(frame.wind.x, frame.wind.z);
      if (cam) {
        ctx.renderer.getDrawingBufferSize(sizeTmp);
        moteMat.uniforms.uPixelScale.value = sizeTmp.y / (2 * Math.tan((cam.fov * Math.PI) / 360));
      }
    }
  }
  function dispose() {
    for (const o of disposables) { o.geometry && o.geometry.dispose(); o.material && o.material.dispose(); }
  }
  return { group, update, dispose };
}
