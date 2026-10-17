/**
 * Petal skin - what makes the petals read as living pink-lotus tissue instead of plastic.
 *
 * One MeshPhysicalMaterial shared by every petal (DoubleSide), patched at the fragment stage:
 *   - inner (concave, gl_FrontFacing) / outer (convex) colour ramps: pale green-cream base -> white -> blush -> rose tip
 *   - fine, dense, parallel, anastomosing veins (colour + bump), per-petal tint, margin deepening
 *   - thin-sheet light transport inside three's light loop (wrap diffuse + back-lit diffuse transmission + forward
 *     scatter lobe) so back-lit petals GLOW, shadow/sun colour/intensity come from the stock light loop
 *   - light arriving from the far side (sky/IBL/hemisphere) transmitted through the sheet
 *   - satin sheen, roughness micro-variation, ambient occlusion by construction (base / bud / cup)
 * The vertex stage (surface + unfurl + the contract varyings) lives in petals.js - see petalContract.js.
 *
 */
import { MeshPhysicalMaterial, DoubleSide, Color, Vector3, Vector4 } from 'three';
import { PALETTE } from '../core/constants.js';
import { addPatch, inject } from '../core/shaderPatch.js';
import { PETAL_VARYINGS_GLSL } from './petalContract.js';

const srgbVec = (hex) => {
  const c = new Color(hex);
  const o = { r: 0, g: 0, b: 0 };
  c.getRGB(o, 'srgb');
  return new Vector3(o.r, o.g, o.b);
};

const GLSL_PARS = /* glsl */ `
${PETAL_VARYINGS_GLSL}
uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uC3; uniform vec3 uC4;   // inner ramp (sRGB encoded)
uniform vec3 uO0; uniform vec3 uO1; uniform vec3 uO2;                                       // outer ramp (sRGB encoded)
uniform vec4 uTrans;     // x gain, y forward-scatter gain, z forward power, w normal distortion
uniform vec4 uTrans2;    // x wrap, y ambient-transmission gain, z thickness->exponent slope, w sheen gain
uniform float uVeinN;    // veins across the petal
uniform float uVeinK;    // vein contrast
uniform float uBloomHint;

float pH11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float pH21(vec2 p){ vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float pVN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(pH21(i), pH21(i + vec2(1., 0.)), f.x), mix(pH21(i + vec2(0., 1.)), pH21(i + vec2(1., 1.)), f.x), f.y); }
float pFBM(vec2 p){ float a = .5, s = 0.; for (int i = 0; i < 4; i++) { s += a * pVN(p); p = p * 2.03 + 17.17; a *= .5; } return s; }

// per-fragment state shared with the RE_Direct wrapper / indirect patch
vec3  gTrans = vec3(0.0);
vec3  gWrapTint = vec3(1.0);
vec3  gAlbedoAmb = vec3(1.0);
float gAO = 1.0;
float gSheenMask = 1.0;
float gVein = 0.0;
float gUnd = 0.0;

vec3 petalInnerRamp(float u, float pink){
  vec3 c = uC0;
  c = mix(c, uC1, smoothstep(0.00, 0.26, u));
  c = mix(c, uC2, smoothstep(0.16, 0.46, u));
  c = mix(c, uC3, smoothstep(0.30, 0.80, u) * min(pink, 1.0));
  c = mix(c, uC4, smoothstep(0.74, 1.00, u) * min(pink, 1.0));
  return c;
}
vec3 petalOuterRamp(float u, float whorl){
  vec3 b = mix(uO0, uC0, whorl * 0.7);
  vec3 c = mix(b, uO1, smoothstep(0.0, 0.5, u));
  return mix(c, uO2, smoothstep(0.35, 0.95, u));
}
// dense, parallel, anastomosing longitudinal veins; fades to its mean when the pitch nears 1 px (no aliasing)
float petalVeins(vec2 st, float seed, float N){
  float warp = (pVN(vec2(st.x * N * 0.11 + seed * 9.0, st.y * 3.0)) - 0.5) * 2.4
             + (pVN(vec2(st.x * N * 0.45, st.y * 11.0 + seed * 3.0)) - 0.5) * 0.55;
  float x = st.x * N + warp;
  float id = floor(x);
  float f = fract(x) - 0.5;
  float strength = 0.30 + 0.70 * pH21(vec2(id, seed * 7.0));
  float w = 0.045 + 0.035 * pH21(vec2(id, 3.1));
  float aa = fwidth(x);
  float line = (1.0 - smoothstep(w, w + 0.17 + aa, abs(f))) * strength;
  float meanV = (2.0 * w + 0.17) * 0.6 * strength;
  return mix(line, meanV, smoothstep(0.30, 0.90, aa));
}
vec3 petalToLinear(vec3 c){ return pow(max(c, vec3(0.0)), vec3(2.2)); }
`;

/** diffuseColor / thickness for the petal (runs after <map_fragment>) */
const GLSL_SURFACE = /* glsl */ `
{
  float s = vPetalUv.x, u = vPetalUv.y;
  float e = abs(2.0 * s - 1.0);
  float whorl = vPetal.y, rnd = vPetal.z, open = vPetal.w;
  float pink = clamp(mix(0.80, 1.18, rnd) * mix(1.12, 0.84, whorl), 0.5, 1.25);

  float n1 = pFBM(vec2(s * 3.1 + rnd * 11.0, u * 2.3 + rnd * 5.0));
  float n2 = pVN(vec2(s * 17.0 + rnd * 31.0, u * 6.0));
  float uw = clamp(u + (n1 - 0.5) * 0.16 + e * 0.07 * smoothstep(0.3, 0.9, u), 0.0, 1.0);

  float vein = petalVeins(vPetalUv, rnd, uVeinN);
  gVein = vein;
  gUnd = n1;

  vec3 inner = petalInnerRamp(uw, pink);
  vec3 outer = petalOuterRamp(uw, whorl);
  vec3 vt = mix(vec3(0.93, 0.99, 0.84), vec3(0.88, 0.60, 0.74), smoothstep(0.15, 0.75, u));
  inner *= mix(vec3(1.0), vt, vein * uVeinK);
  outer *= mix(vec3(1.0), vt, vein * uVeinK * 1.4);
  inner *= 1.0 + (n2 - 0.5) * 0.06;
  inner = mix(inner, inner * vec3(0.96, 0.84, 0.92), smoothstep(0.72, 1.0, e) * smoothstep(0.4, 0.9, u) * 0.6);
  float li = dot(inner, vec3(0.333));
  inner = mix(vec3(li), inner, 1.0 + 0.35 * (pink - 1.0));

  vec3 albSRGB = gl_FrontFacing ? inner : outer;
  vec3 alb = petalToLinear(albSRGB);
  diffuseColor.rgb = alb;

  float thick = clamp(vPetalGeo.z * (0.62 + 0.38 * (1.0 - e * e)) + vein * 0.16 * (0.5 + 0.5 * u), 0.0, 1.0);
  vec3 tAlb = petalToLinear(inner);
  gTrans = pow(tAlb, vec3(mix(0.62, 0.62 + uTrans2.z, thick))) * exp(-thick * 2.2) * uTrans.x;
  gWrapTint = pow(max(alb, vec3(1e-3)), vec3(0.55));
  gAlbedoAmb = pow(alb, vec3(1.12));
  gAO = mix(1.0, smoothstep(0.0, 0.45, u), 0.10 + 0.16 * (1.0 - open)) * (1.0 - 0.10 * vPetalGeo.x * (1.0 - u));
  gSheenMask = uTrans2.w * (0.75 + 0.5 * smoothstep(0.1, 0.8, u)) * (1.0 - 0.35 * vein);
}
`;

const GLSL_ROUGH = /* glsl */ `
roughnessFactor = clamp(roughnessFactor + (gVein - 0.25) * 0.10 + (pVN(vPetalUv * vec2(9.0, 5.0)) - 0.5) * 0.12, 0.3, 0.9);
`;

/** bump from the vein field - re-evaluates the field at +dFdx/+dFdy (same trick as three's bumpMap) */
const GLSL_BUMP = /* glsl */ `
{
  vec2 dH = vec2(dFdx(gVein), dFdy(gVein)) * 0.0032 + vec2(dFdx(gUnd), dFdy(gUnd)) * 0.010;
  vec3 sX = normalize(dFdx(- vViewPosition)), sY = normalize(dFdy(- vViewPosition));
  vec3 R1 = cross(sY, normal), R2 = cross(normal, sX);
  float det = dot(sX, R1) * faceDirection;
  vec3 grad = sign(det) * (dH.x * R1 + dH.y * R2);
  normal = normalize(abs(det) * normal - grad);
}
`;

/** Thin-sheet transport, wrapped around three's RE_Direct so it runs inside the stock light loops (shadows included). */
const GLSL_RE_DIRECT = /* glsl */ `
void RE_Direct_Petal( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  vec3 L = directLight.direction;
  float NL = dot( geometryNormal, L );
  float wrapD = saturate( ( NL + uTrans2.x ) / ( 1.0 + uTrans2.x ) ) - saturate( NL );
  reflectedLight.directDiffuse += directLight.color * material.diffuseContribution * gWrapTint * ( wrapD * RECIPROCAL_PI );
  float back = saturate( - NL );
  vec3 H = normalize( L + geometryNormal * uTrans.w );
  float fwd = pow( max( saturate( dot( geometryViewDir, - H ) ), 1e-4 ), uTrans.z );
  reflectedLight.directDiffuse += directLight.color * gTrans * RECIPROCAL_PI * ( back + uTrans.y * fwd );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Petal
`;

/** light arriving from the other side of the sheet (sky / env / hemisphere), then custom AO */
const GLSL_INDIRECT = /* glsl */ `
{
  vec3 irrBack = vec3( 0.0 );
  #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
    irrBack += getIBLIrradiance( - geometryNormal ) * RECIPROCAL_PI;
  #endif
  #if NUM_HEMI_LIGHTS > 0
    irrBack += getHemisphereLightIrradiance( hemisphereLights[ 0 ], - geometryNormal );
  #endif
  reflectedLight.indirectDiffuse += irrBack * gTrans * uTrans2.y;
  reflectedLight.indirectDiffuse *= gAO;
  reflectedLight.indirectSpecular *= mix( 1.0, gAO, 0.6 );
  #ifdef USE_SHEEN
    sheenSpecularIndirect *= gAO;
  #endif
}
`;

/**
 * @param {import('../main.js').Ctx} ctx
 * @param {object} [opts]
 * @returns {{ material: MeshPhysicalMaterial, uniforms: object, update(frame): void, dispose(): void }}
 */
export function createPetalSkin(ctx, opts = {}) {
  const tier = (ctx && ctx.quality && ctx.quality.tier) || 'high';
  const full = tier !== 'low';

  const material = new MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.55,
    metalness: 0,
    ior: 1.4,
    specularIntensity: 0.6,
    side: DoubleSide,
    sheen: 1.0,
    sheenColor: new Color('#ffe2ec'),
    sheenRoughness: 0.5,
  });

  const U = {
    uC0: { value: srgbVec(PALETTE.petalBase) },
    uC1: { value: srgbVec('#f8f4de') },
    uC2: { value: srgbVec('#f9d3df') },
    uC3: { value: srgbVec('#f09ac0') },
    uC4: { value: srgbVec('#d4467f') },
    uO0: { value: srgbVec(PALETTE.petalOuterBack) },
    uO1: { value: srgbVec('#f3dde0') },
    uO2: { value: srgbVec('#e0558c') },
    uTrans: { value: new Vector4(1.0, 1.4, 5.0, 0.35) },
    uTrans2: { value: new Vector4(0.28, 0.55, 1.0, 1.0) },
    uVeinN: { value: tier === 'low' ? 52 : 84 },
    uVeinK: { value: 0.62 },
    uBloomHint: { value: 0 },
  };
  material.userData.uniforms = U;

  addPatch(material, {
    key: `petal-skin-v2-${full ? 'F' : 'L'}`,
    uniforms: U,
    fragment: (f) => {
      f = inject(f, 'lights_physical_pars_fragment', GLSL_PARS + GLSL_RE_DIRECT);
      f = inject(f, 'map_fragment', GLSL_SURFACE);
      f = inject(f, 'roughnessmap_fragment', GLSL_ROUGH);
      if (full) f = inject(f, 'normal_fragment_maps', GLSL_BUMP);
      f = inject(f, 'lights_physical_fragment', '#ifdef USE_SHEEN\n material.sheenColor *= gSheenMask;\n#endif');
      f = inject(f, 'lights_fragment_end', 'material.diffuseContribution = gAlbedoAmb;', 'before');
      f = inject(f, 'lights_fragment_end', GLSL_INDIRECT);
      return f;
    },
  });

  return {
    material,
    uniforms: U,
    update(frame) {},
    dispose() { material.dispose(); },
  };
}
