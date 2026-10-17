/**
 * Sparkles - a slow, sparse swirl of golden pollen-light that lifts off the open flower (birthday pages only).
 *
 * Pure GPU, closed form: every particle's position is a function of (time, its seed), so there is no per-frame CPU work and
 * no state to keep in sync. Each one lives 6-11 s: it leaves the stamens, climbs in a lazy spiral, drifts with the wind and
 * fades; every cycle re-rolls its start, colour and twinkle, so the swirl never visibly repeats. HDR values > 1 so the bloom
 * pass gives the brightest glints a soft halo; a few big ones get a small 4-point glint. Depth-tested (petals hide them),
 * additive, and mirrored in the pond because they live in the scene like everything else.
 *
 * `gain` fades the whole system in with the bloom, so the pond is untouched until the flower is nearly open.
 */
import { Group, Points, BufferGeometry, Float32BufferAttribute, ShaderMaterial, AdditiveBlending, Vector2 } from 'three';
import { smoothstep } from '../core/timeline.js';

const VERT = /* glsl */ `
attribute vec4 aSeed;       // x phase, y life 0..1, z size 0..1, w colour/glint seed
uniform float uTime;
uniform vec3 uFocus;        // visual centre of the flower (live, shared with the frame)
uniform float uRadius;      // current flower radius
uniform vec2 uWind;
uniform float uPixelScale;  // pixels per world unit at distance 1 (set per render pass, see onBeforeRender)
uniform float uMaxPoint;    // largest point size in pixels for the target in use
uniform float uGain;
varying vec3 vCol;
varying float vA;
varying float vGlint;

float h11(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }

void main() {
  float life = mix(6.0, 11.0, aSeed.y);
  float cyc = uTime / life + aSeed.x;
  float age = fract(cyc);
  float cycle = mod(floor(cyc), 512.0);                      // wrapped: sin() of ever larger arguments loses its randomness on mobile GPUs
  float id = aSeed.x * 97.0 + cycle * 13.37;                 // new random draw every cycle
  float h1 = h11(id + 1.0), h2 = h11(id + 2.0), h3 = h11(id + 3.0), h4 = h11(id + 4.0), h5 = h11(id + 5.0), h6 = h11(id + 6.0);

  // leave the stamens, climb in a lazy spiral that opens outwards
  float r0 = (0.06 + 0.5 * sqrt(h2)) * uRadius * 0.55;
  float r = r0 + pow(age, 0.85) * uRadius * (0.55 + 1.1 * h3);
  float th = 6.2831853 * h1 + age * (0.9 + 1.4 * h4) * (h5 < 0.5 ? 1.0 : -1.0);
  float rise = pow(age, 0.8) * uRadius * (1.6 + 2.4 * h6);
  vec3 p = uFocus + vec3(cos(th) * r, 0.18 + rise, sin(th) * r);
  p.xz += uWind * age * age * uRadius * 1.1;
  p.x += sin(uTime * (0.9 + h3 * 1.6) + id) * 0.05 * uRadius;
  p.z += cos(uTime * (0.8 + h4 * 1.5) + id * 1.3) * 0.05 * uRadius;

  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float dist = max(-mv.z, 0.5);

  float tw = 0.5 + 0.5 * sin(uTime * (2.2 + 4.5 * h4) + id * 3.1);
  tw = tw * tw * tw;
  float fade = smoothstep(0.0, 0.10, age) * (1.0 - smoothstep(0.55, 1.0, age));
  vA = fade * (0.22 + 0.78 * tw) * uGain;
  vGlint = tw * step(0.78, aSeed.w);                         // only the larger, brighter ~20 % get a 4-point glint

  // gold, warm white and a little petal pink
  vec3 gold = vec3(1.0, 0.70, 0.30), cream = vec3(1.0, 0.90, 0.72), rose = vec3(1.0, 0.58, 0.68);
  float c = h11(aSeed.w * 71.0 + cycle);
  vCol = (c < 0.58 ? gold : c < 0.86 ? cream : rose) * 1.7;      // HDR: the bloom pass gives the brightest glints a soft halo

  float size = (0.022 + 0.05 * aSeed.z * aSeed.z) * mix(1.0, 2.2, step(0.78, aSeed.w)) * (0.7 + 0.3 * tw);
  gl_PointSize = clamp(size * uPixelScale / dist, uMaxPoint / 28.0, uMaxPoint);
}
`;

const FRAG = /* glsl */ `
varying vec3 vCol;
varying float vA;
varying float vGlint;
void main() {
  if (vA < 0.004) discard;
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(q, q);
  float core = exp(-8.0 * d2) + 0.2 * exp(-2.4 * d2);                 // bright pin + soft halo
  float glint = (exp(-abs(q.x) * 16.0) * exp(-abs(q.y) * 2.4) + exp(-abs(q.y) * 16.0) * exp(-abs(q.x) * 2.4)) * 0.9 * vGlint;   // (not "cross": that is a GLSL built-in)
  float a = (core + glint) * (1.0 - smoothstep(0.85, 1.0, sqrt(d2))) * vA;
  if (a < 0.03) discard;           // depth is written only where a sparkle is really visible (see createSparkles)
  gl_FragColor = vec4(vCol, a);    // additive blending multiplies by alpha once: the falloff is linear, the soft halo survives
}
`;

/** @param {import('../main.js').Ctx} ctx */
export function createSparkles(ctx) {
  const rng = ctx.rng.fork('sparkles');
  const n = Math.max(24, Math.round(560 * ctx.quality.particles));

  const seed = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) seed.set([rng.next(), rng.next(), rng.next(), rng.next()], i * 4);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aSeed', new Float32BufferAttribute(seed, 4));

  // depthWrite on (with a discard in the fragment shader): the depth-of-field pass derives each pixel's blur from the depth buffer,
  // and a sparkle that wrote no depth would be blurred as if it sat at the far sky behind it and smear into nothing. As a
  // small in-focus disc at the flower's distance it stays crisp, like real pollen glints at the focal plane.
  const mat = new ShaderMaterial({
    transparent: true, depthWrite: true, depthTest: true, blending: AdditiveBlending, fog: false,
    uniforms: {
      uTime: { value: 0 }, uFocus: { value: ctx.frame.focus }, uRadius: { value: 1.2 }, uWind: { value: new Vector2() },
      uPixelScale: { value: 600 }, uMaxPoint: { value: 56 }, uGain: { value: 0 },
    },
    vertexShader: VERT, fragmentShader: FRAG,
  });
  const points = new Points(geo, mat);
  points.name = 'sparkles';
  points.frustumCulled = false;
  points.renderOrder = 30;                       // after the flower, leaves and the other motes
  points.visible = false;
  const group = new Group();
  group.name = 'sparkles';
  group.add(points);

  // The same points are drawn into the main buffer, the water-reflection target (a fraction of its size) and the 4K capture. The pixel
  // scale and the size cap are therefore set per pass from the render target actually in use, so a sparkle keeps the same size
  // relative to the frame in all of them (a fixed device-pixel cap made glints smaller on 3x phones and in saved pictures).
  const size = new Vector2();
  points.onBeforeRender = (renderer, scene, camera) => {
    const target = renderer.getRenderTarget();
    const h = target ? target.height : renderer.getDrawingBufferSize(size).y;
    mat.uniforms.uPixelScale.value = h / (2 * Math.tan((camera.fov * Math.PI) / 360));
    mat.uniforms.uMaxPoint.value = (56 * h) / 720;
  };

  // reduced motion: the swirl still drifts, at a third of the speed
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** @param {ReturnType<typeof import('../core/timeline.js').createFrame>} frame */
  function update(frame) {
    const gain = smoothstep(0.66, 0.97, frame.bloom);
    points.visible = gain > 0.002;
    if (!points.visible) return;
    const u = mat.uniforms;
    u.uTime.value = frame.time * (reduced ? 0.3 : 1);
    u.uGain.value = gain;
    u.uRadius.value = Math.max(0.6, frame.flowerRadius || 1.2);
    u.uWind.value.set(frame.wind.x, frame.wind.z);
  }
  function dispose() { geo.dispose(); mat.dispose(); }
  return { group, update, dispose, points };
}
