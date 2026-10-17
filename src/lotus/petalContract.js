/**
 * Contract between  petals.js (vertex stage: parametric petal surface + unfurl deformation)  and
 *                   petalSkin.js (fragment stage: colour, veins, translucency, sheen).
 * Both files import these strings so the two shader patches can never disagree.
 *
 * Geometry attributes written by petals.js onto every petal BufferGeometry:
 *   uv       vec2   x = s  across the petal 0..1 (0.5 = midrib), y = u  along the petal 0 (base) .. 1 (tip)
 *   aPetal   float  petal index 0..N-1
 *   aLayer   float  whorl 0 (outermost) .. 1 (innermost), normalised
 *   aSeed    float  per-petal random 0..1 (stable; from ctx.rng)
 *
 * Winding / facing: triangles are wound so that gl_FrontFacing == true on the CONCAVE (inner/upper) face
 * of the petal - the face you see when looking down into an open flower. The back (outer/convex) face is
 * the underside. petalSkin colours the two faces differently (outer face: greener base, more saturated).
 * The vertex stage must output a correct unit normal for the FRONT face (three flips it for back faces).
 *
 * Varyings (declared in BOTH stages from the strings below; petals.js assigns them, petalSkin reads them):
 */
export const PETAL_ATTRIBUTES_GLSL = /* glsl */ `
attribute float aPetal;
attribute float aLayer;
attribute float aSeed;
`;

export const PETAL_VARYINGS_GLSL = /* glsl */ `
varying vec2 vPetalUv;   // (s across 0..1, u along 0..1)  - identical to the uv attribute
varying vec4 vPetal;     // x = petal index, y = whorl 0 outer..1 inner, z = per-petal random 0..1, w = this petal's openness 0 (bud) .. 1 (fully open)
varying vec3 vPetalGeo;  // x = cupping 0 flat..1 strongly cupped, y = margin proximity 0 at the edge .. 1 at the midrib, z = thickness factor 0 paper-thin .. 1 fleshy
`;

/**
 * Vertex-stage assignment contract (petals.js MUST do this for every vertex):
 *   vPetalUv = uv;
 *   vPetal   = vec4(aPetal, aLayer, aSeed, openness);
 *   vPetalGeo = vec3(cup, marginProximity, thickness);
 *
 * Both patches are applied with  material.onBeforeCompile  CHAINED (via core/shaderPatch.js addPatch):
 *   const prev = material.onBeforeCompile;
 *   material.onBeforeCompile = (shader, renderer) => { prev.call(material, shader, renderer); ...own patch... };
 * and the same customProgramCacheKey strategy must be used so programs are shared correctly.
 */
export const PETAL_CONTRACT_VERSION = 1;
