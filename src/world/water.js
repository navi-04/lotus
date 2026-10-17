/**
 * Water - dark dawn pond. Schlick-Fresnel mix of a deep body colour and a reflection, where the reflection is a
 * mirrored-camera planar render (half-float HDR, includes the sky dome) on capable tiers, or the analytic sky on `low`.
 * Surface detail: scrolling swell + capillary noise gradients, 16 expanding ripple rings (ctx.ripple), ambient raindrop
 * rings, sun glitter, soft darkening under/around floating leaves (ctx.pondLayout.leafDisks), fog toward the horizon.
 * Built on the math of three's examples/jsm/objects/Reflector.js (verified r186).
 */
import {
  Mesh, PlaneGeometry, ShaderMaterial, WebGLRenderTarget, HalfFloatType, UnsignedByteType, Matrix4, Plane, Vector3, Vector4, Vector2,
  PerspectiveCamera, Color, UniformsLib, UniformsUtils, LinearFilter,
} from 'three';
import { SCENE, PALETTE } from '../core/constants.js';
import { SKY_FUNCS_GLSL } from './envSky.js';

const MAX_RIPPLES = 16;
const MAX_LEAVES = 16;

const VERT = /* glsl */ `
uniform mat4 textureMatrix;
varying vec4 vRefl;
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vRefl = textureMatrix * vec4(position, 1.0);
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = (useRT, ambient) => /* glsl */ `
#define AMBIENT_RINGS ${ambient}
${SKY_FUNCS_GLSL}
uniform sampler2D tDiffuse;
uniform vec3 uBody;
uniform vec3 uDeep;
uniform vec4 uRipple[${MAX_RIPPLES}];   // x, z, age (s), amplitude
uniform vec3 uLeaf[${MAX_LEAVES}];      // x, z, radius
uniform int uLeafCount;
uniform vec2 uTexel;
varying vec4 vRefl;
varying vec3 vWorld;
#include <fog_pars_fragment>

float wH21(vec2 p) { vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float wVN(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(wH21(i), wH21(i + vec2(1., 0.)), f.x), mix(wH21(i + vec2(0., 1.)), wH21(i + vec2(1., 1.)), f.x), f.y);
}
float wFBM(vec2 p) { return wVN(p) * 0.6 + wVN(p * 2.07 + 11.3) * 0.4; }

vec2 waveGrad(vec2 p, float t) {
  vec2 g = vec2(0.0);
  g += vec2(0.70, 0.30) * 0.018 * cos(dot(p, vec2(0.70, 0.30)) * 0.9 + t * 0.55);
  g += vec2(-0.40, 0.90) * 0.012 * cos(dot(p, vec2(-0.40, 0.90)) * 1.7 + t * 0.70);
  vec3 n1 = pnoised(vec2(p.x * 1.5 + t * 0.10, p.y * 2.3 - t * 0.07));
  vec3 n2 = pnoised(vec2(p.x * 4.1 - t * 0.15, p.y * 5.9 + t * 0.11));
  g += n1.yz * 0.030 + n2.yz * 0.012;
  return g;
}

// one expanding ring: returns the gradient contribution
vec2 ringGrad(vec2 p, vec2 c, float age, float amp) {
  if (amp <= 0.0 || age < 0.0 || age > 7.0) return vec2(0.0);
  vec2 d = p - c;
  float dist = length(d);
  float R = age * 0.85;
  float x = dist - R;
  float k = 17.0;
  float s2 = 2.4;
  float env = exp(-pow(x * s2, 2.0));
  float dw = k * cos(k * x) * env + sin(k * x) * (-2.0 * s2 * s2 * x) * env;
  float fade = exp(-age * 0.55) * smoothstep(0.0, 0.35, age) / (1.0 + dist * 0.6);
  return d / max(dist, 1e-3) * dw * amp * fade * 0.05;
}

void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  vec2 g = waveGrad(vWorld.xz, uTime);
  for (int i = 0; i < ${MAX_RIPPLES}; i++) g += ringGrad(vWorld.xz, uRipple[i].xy, uRipple[i].z, uRipple[i].w);
  // ambient raindrop rings: 6 slow streams, deterministic from time
  for (int i = 0; i < AMBIENT_RINGS; i++) {
    float fi = float(i);
    float period = 4.0 + fi * 1.3;
    float cyc = floor((uTime + fi * 2.1) / period);
    float age = mod(uTime + fi * 2.1, period);
    vec2 c = (hash22(vec2(cyc, fi * 7.7 + 1.0)) - 0.5) * 2.0 * vec2(9.0, 7.0) + vec2(0.0, -2.0);
    g += ringGrad(vWorld.xz, c, age, 0.22);
  }

  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  float nv = clamp(dot(n, V), 0.0, 1.0);
  float F = clamp(0.025 + 0.975 * pow(1.0 - nv, 4.5), 0.03, 1.0);

  vec3 refl;
  ${useRT ? `
  vec2 uvR = vRefl.xy / vRefl.w + g * 0.045;
  refl = texture2D(tDiffuse, uvR).rgb * 0.40
       + texture2D(tDiffuse, uvR + vec2( uTexel.x * 1.6, 0.0)).rgb * 0.15
       + texture2D(tDiffuse, uvR - vec2( uTexel.x * 1.6, 0.0)).rgb * 0.15
       + texture2D(tDiffuse, uvR + vec2(0.0,  uTexel.y * 1.6)).rgb * 0.15
       + texture2D(tDiffuse, uvR - vec2(0.0,  uTexel.y * 1.6)).rgb * 0.15;
  ` : `
  refl = skyRadiance(normalize(reflect(-V, n)));
  `}

  // leaves: darken the water around/under floating pads (contact shadow + occluded sky light)
  float shade = 0.0;
  for (int i = 0; i < ${MAX_LEAVES}; i++) {
    if (i >= uLeafCount) break;
    float d = length(vWorld.xz - uLeaf[i].xy) / uLeaf[i].z;
    shade = max(shade, 1.0 - smoothstep(0.95, 1.4, d));
  }

  vec3 body = mix(uBody, uDeep, smoothstep(0.0, 1.0, 1.0 - nv) * 0.6);
  body *= 1.0 - 0.6 * shade;
  vec3 col = mix(body, refl * (1.0 - 0.45 * shade), F);

  // sun glitter on the ripples
  vec3 H = normalize(uSunDir + V);
  float NH = max(dot(n, H), 0.0);
  float a = 0.035, a2 = a * a;
  float dd = NH * NH * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159265 * dd * dd);
  float spec = D * F * max(dot(n, uSunDir), 0.0) * 0.12;
  col += uSunCol * 0.18 * spec;

  // drifting ground mist hugging the water: thicker with distance, thinned right around the hero and under the camera
  {
    float dCam = length(vWorld - cameraPosition);
    vec2 mp = vWorld.xz * 0.05;
    float mn = wFBM(mp + vec2(uTime * 0.010, uTime * 0.004));
    float mn2 = wVN(mp * 2.4 - vec2(uTime * 0.018, 0.0) + 5.0);
    float wisp = smoothstep(0.30, 0.78, mn * 0.7 + mn2 * 0.3);
    float far = smoothstep(3.0, 38.0, dCam);
    float hole = smoothstep(1.5, 8.0, length(vWorld.xz));
    col = mix(col, vec3(0.95, 0.78, 0.62) * 0.95, wisp * far * hole * 0.45);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/** @param {import('../main.js').Ctx} ctx */
export function createWater(ctx) {
  const { renderer, quality } = ctx;
  const useRT = quality.reflection > 0;
  const R = SCENE.water.radius;

  const geometry = new PlaneGeometry(R * 2, R * 2, 1, 1);
  const textureMatrix = new Matrix4();
  const hdrOK = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
  const rt = useRT ? new WebGLRenderTarget(512, 512, { type: hdrOK ? HalfFloatType : UnsignedByteType, samples: quality.msaa > 0 && quality.tier !== 'medium' ? 2 : 0, depthBuffer: true }) : null;
  if (rt) { rt.texture.minFilter = LinearFilter; rt.texture.magFilter = LinearFilter; rt.texture.generateMipmaps = false; }

  const ripples = Array.from({ length: MAX_RIPPLES }, () => new Vector4(0, 0, 99, 0));
  const rippleBirth = new Float32Array(MAX_RIPPLES).fill(-1e9);
  let ripHead = 0;
  const leaves = Array.from({ length: MAX_LEAVES }, () => new Vector3(0, 0, 1));

  // NOTE: UniformsUtils.merge/clone would deep-copy (and null) our live objects - clone only the fog block.
  const uniforms = Object.assign(UniformsUtils.clone(UniformsLib.fog), {
    tDiffuse: { value: rt ? rt.texture : null },
    textureMatrix: { value: textureMatrix },
    uBody: { value: new Color(PALETTE.water) },
    uDeep: { value: new Color(PALETTE.waterDeep) },
    uRipple: { value: ripples },
    uLeaf: { value: leaves },
    uLeafCount: { value: 0 },
    uTexel: { value: new Vector2(1 / 512, 1 / 512) },
    uSunDir: { value: ctx.sun.direction },
    uSunCol: { value: new Color(8.0, 6.2, 4.2) },
    uSunDisc: { value: 0 },
    uTime: { value: 0 },
    uClouds: { value: 0 },
  });
  const material = new ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG(useRT, { low: 2, medium: 3, high: 4, ultra: 6 }[quality.tier] || 4), fog: true });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'water';
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = SCENE.water.y;
  mesh.matrixAutoUpdate = true;
  mesh.updateMatrixWorld(true);
  mesh.renderOrder = -1;

  // --- planar reflection (Reflector math) -----------------------------------------------------------------------
  const reflCam = new PerspectiveCamera();
  const reflectorPlane = new Plane();
  const normal = new Vector3();
  const reflWorldPos = new Vector3();
  const camWorldPos = new Vector3();
  const rotMat = new Matrix4();
  const lookAt = new Vector3();
  const clipPlane = new Vector4();
  const view = new Vector3();
  const target = new Vector3();
  const q = new Vector4();
  const bufSize = new Vector2();
  const clipBias = 0.003;

  // the frame governor can ask for the reflection to be refreshed less often and drawn smaller (core/shed.js)
  let reflEvery = 1, reflScale = 1, reflTick = 0, reflDrawn = false;
  const setReflection = ({ every = 1, scale = 1 } = {}) => { reflEvery = Math.max(1, every | 0); reflScale = Math.min(1, Math.max(0.1, scale)); };

  if (useRT) {
    mesh.onBeforeRender = function (rend, scene, camera) {
      if (reflDrawn && reflEvery > 1 && ++reflTick % reflEvery !== 0) return;      // keep the last reflection (and its matrix) for this frame
      reflWorldPos.setFromMatrixPosition(mesh.matrixWorld);
      camWorldPos.setFromMatrixPosition(camera.matrixWorld);
      rotMat.extractRotation(mesh.matrixWorld);
      normal.set(0, 0, 1).applyMatrix4(rotMat);
      view.subVectors(reflWorldPos, camWorldPos);
      if (view.dot(normal) > 0) return;                       // camera below the surface

      // keep the RT proportional to the drawing buffer
      rend.getDrawingBufferSize(bufSize);
      const w = Math.max(64, Math.floor(bufSize.x * quality.reflection * reflScale));
      const h = Math.max(64, Math.floor(bufSize.y * quality.reflection * reflScale));
      if (w !== rt.width || h !== rt.height) { rt.setSize(w, h); uniforms.uTexel.value.set(1 / w, 1 / h); }

      view.reflect(normal).negate().add(reflWorldPos);
      rotMat.extractRotation(camera.matrixWorld);
      lookAt.set(0, 0, -1).applyMatrix4(rotMat).add(camWorldPos);
      target.subVectors(reflWorldPos, lookAt).reflect(normal).negate().add(reflWorldPos);
      reflCam.position.copy(view);
      reflCam.up.set(0, 1, 0).applyMatrix4(rotMat).reflect(normal);
      reflCam.lookAt(target);
      reflCam.far = camera.far;
      reflCam.updateMatrixWorld();
      reflCam.projectionMatrix.copy(camera.projectionMatrix);

      textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
      textureMatrix.multiply(reflCam.projectionMatrix).multiply(reflCam.matrixWorldInverse).multiply(mesh.matrixWorld);

      reflectorPlane.setFromNormalAndCoplanarPoint(normal, reflWorldPos);
      reflectorPlane.applyMatrix4(reflCam.matrixWorldInverse);
      clipPlane.set(reflectorPlane.normal.x, reflectorPlane.normal.y, reflectorPlane.normal.z, reflectorPlane.constant);
      const pm = reflCam.projectionMatrix;
      q.x = (Math.sign(clipPlane.x) + pm.elements[8]) / pm.elements[0];
      q.y = (Math.sign(clipPlane.y) + pm.elements[9]) / pm.elements[5];
      q.z = -1.0;
      q.w = (1.0 + pm.elements[10]) / pm.elements[14];
      clipPlane.multiplyScalar(2.0 / clipPlane.dot(q));
      pm.elements[2] = clipPlane.x;
      pm.elements[6] = clipPlane.y;
      pm.elements[10] = clipPlane.z + 1.0 - clipBias;
      pm.elements[14] = clipPlane.w;

      mesh.visible = false;
      const prevRT = rend.getRenderTarget();
      const prevXr = rend.xr.enabled;
      const prevShadow = rend.shadowMap.autoUpdate;
      rend.xr.enabled = false;
      rend.shadowMap.autoUpdate = false;
      rend.setRenderTarget(rt);
      rend.state.buffers.depth.setMask(true);
      if (rend.autoClear === false) rend.clear();
      rend.render(scene, reflCam);
      rend.xr.enabled = prevXr;
      rend.shadowMap.autoUpdate = prevShadow;
      rend.setRenderTarget(prevRT);
      const vp = camera.viewport;
      if (vp !== undefined) rend.state.viewport(vp);
      mesh.visible = true;
      reflDrawn = true;
    };
  }

  // --- ripple events -----------------------------------------------------------------------------------------------
  ctx.ripple = (x, z, strength = 1) => {
    const t = ctx.frame ? ctx.frame.time : 0;
    ripples[ripHead].set(x, z, 0, Math.min(1.5, Math.max(0.05, strength)));
    rippleBirth[ripHead] = t;
    ripHead = (ripHead + 1) % MAX_RIPPLES;
  };

  function update(frame) {
    uniforms.uTime.value = frame.time;
    for (let i = 0; i < MAX_RIPPLES; i++) {
      const age = frame.time - rippleBirth[i];
      if (age > 7) ripples[i].w = 0; else ripples[i].z = age;
    }
    const disks = ctx.pondLayout.leafDisks;
    const n = Math.min(disks.length, MAX_LEAVES);
    uniforms.uLeafCount.value = n;
    for (let i = 0; i < n; i++) leaves[i].set(disks[i].x, disks[i].z, disks[i].r);
  }

  function dispose() {
    geometry.dispose(); material.dispose(); if (rt) rt.dispose();
  }
  return { group: mesh, update, dispose, mesh, setReflection };
}
