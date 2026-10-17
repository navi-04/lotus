/**
 * Compact GLSL noise (WebGL2 / GLSL ES 3.00) - only what the scene uses, so every shader that embeds it stays small
 * (shader compile time matters on phones). Sine-free hashes, 2D Perlin gradient noise with analytic derivatives.
 *
 *   vec2  hash22(vec2)            uniform [0,1) per component
 *   float hash21(vec2)
 *   vec3  pnoised(vec2 p)         (value in ~[-1,1], d/dx, d/dy)
 *   float pnoise(vec2 p)
 *   float fbm(vec2 p, int oct)    2..5 octaves of rotated gradient noise, ~[-1,1]
 */
export const GLSL_NOISE_LITE = /* glsl */ `
#ifndef LOTUS_NOISE_LITE
#define LOTUS_NOISE_LITE
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 lgrad(vec2 i) { vec2 h = hash22(i) * 2.0 - 1.0; return h / max(length(h), 1e-3); }
vec3 pnoised(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec2 ga = lgrad(i), gb = lgrad(i + vec2(1.0, 0.0)), gc = lgrad(i + vec2(0.0, 1.0)), gd = lgrad(i + vec2(1.0, 1.0));
  float va = dot(ga, f), vb = dot(gb, f - vec2(1.0, 0.0)), vc = dot(gc, f - vec2(0.0, 1.0)), vd = dot(gd, f - vec2(1.0, 1.0));
  float k = va - vb - vc + vd;
  float v = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * k;
  vec2 d = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd) + du * (u.yx * k + vec2(vb, vc) - va);
  return vec3(v * 1.41, d * 1.41);
}
float pnoise(vec2 p) { return pnoised(p).x; }
float fbm(vec2 p, int oct) {
  float a = 0.5, s = 0.0;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    if (i >= oct) break;
    s += a * pnoise(p);
    p = r * p * 2.02 + 17.3;
    a *= 0.5;
  }
  return s * 1.6;
}
#endif
`;
