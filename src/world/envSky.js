/**
 * Shared dawn-sky radiance function (GLSL). Used by the sky dome, the IBL bake and the water's low-tier fallback.
 * Needs uniforms: uSunDir (vec3), uSunCol (vec3), uSunDisc (float), uTime (float), uClouds (float).
 */
import { GLSL_NOISE_LITE } from '../core/noiseLite.js';

export const SKY_UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform float uSunDisc;
uniform float uTime;
uniform float uClouds;
`;

export const SKY_FUNCS_GLSL = /* glsl */ `
${GLSL_NOISE_LITE}
${SKY_UNIFORMS_GLSL}
vec3 skyRadiance(vec3 rd) {
  float h = rd.y;
  // linear-light dawn gradient: deep blue zenith -> lavender -> peach/gold horizon
  vec3 zen = vec3(0.15, 0.22, 0.42);
  vec3 mid = vec3(0.62, 0.52, 0.56);
  vec3 hor = vec3(1.15, 0.66, 0.40);
  vec3 sky = mix(hor, mid, smoothstep(0.0, 0.20, h));
  sky = mix(sky, zen, smoothstep(0.10, 0.78, h));

  float sd = max(dot(rd, uSunDir), 0.0);
  vec3 glow = vec3(1.0, 0.64, 0.34);
  sky += glow * (0.50 * pow(sd, 5.0) + 1.7 * pow(sd, 48.0) + 2.6 * pow(sd, 420.0));
  sky += uSunCol * uSunDisc * smoothstep(0.99955, 0.99988, sd);
  // luminous haze hugging the horizon, stronger toward the sun
  sky += vec3(0.60, 0.40, 0.27) * exp(-abs(h) * 11.0) * (0.30 + 0.55 * pow(sd, 3.0));

  // thin warm cirrus wisps
  if (uClouds > 0.0 && h > 0.01) {
    vec2 cp = rd.xz / (h + 0.16) * 1.15 + vec2(uTime * 0.004, uTime * 0.0015);
    float c = fbm(vec2(cp.x * 0.9, cp.y * 2.4), 5);
    float c2 = fbm(vec2(cp.x * 2.1 + 7.0, cp.y * 5.0), 4);
    float cloud = smoothstep(0.46, 0.80, c * 0.75 + c2 * 0.25 + 0.05) * smoothstep(0.015, 0.22, h) * (1.0 - smoothstep(0.5, 0.95, h));
    vec3 lit = mix(vec3(0.80, 0.52, 0.48), vec3(1.55, 0.98, 0.62), pow(sd, 2.5));
    sky = mix(sky, lit, cloud * 0.55 * uClouds);
  }
  // below the horizon: dark warm-green water/foliage bounce, melting into the haze
  vec3 gnd = vec3(0.045, 0.060, 0.042) + hor * 0.05;
  return mix(sky, gnd, smoothstep(0.0, -0.07, h));
}
`;
