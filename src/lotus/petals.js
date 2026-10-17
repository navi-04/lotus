/**
 * Petals - ~22 parametric petals in 4 whorls, unfurled on the GPU.
 *
 * Architecture (cheap on mobile, exact on desktop):
 *   CPU, per frame (22 petals x (NU+1) rows): integrate each petal's inextensible CENTRE LINE from a bending-angle
 *   law theta(u) (angle from the flower axis, + = outward), and write per-row shape data into two small float
 *   textures: A = (radial, vertical, theta, half-width), B = (cup curvature, twist, ruffle amplitude, shell offset).
 *   GPU vertex stage: reads the rows, builds the cylindrical cross-section (cup), twist and margin ruffle, and
 *   derives analytic-quality normals by central differences. No per-vertex integration => ~16 trig ops/vertex.
 * Winding: gl_FrontFacing == concave (inner/upper) face (see petalContract.js). Material: petalSkin.js.
 */
import {
  BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute, Uint16BufferAttribute, Mesh, Group, Vector4, Sphere, Vector3,
  DataTexture, RGBAFormat, FloatType, NearestFilter, ClampToEdgeWrapping, MeshDepthMaterial, RGBADepthPacking, ShaderChunk,
} from 'three';
import { makeRng } from '../core/rng.js';
import { smoothstep, lerp, clamp01 } from '../core/timeline.js';
import { addPatch, inject, replaceOnce } from '../core/shaderPatch.js';
import { PETAL_ATTRIBUTES_GLSL, PETAL_VARYINGS_GLSL } from './petalContract.js';
import { createPetalSkin } from './petalSkin.js';

const D = Math.PI / 180;

/**
 * Whorl definitions. Angles are degrees from the flower axis (+ = leaning outward). t0 = angle at the base,
 * t1 = angle at the tip, p = how late the bending happens along the length (>1 = near the tip); c = closed
 * bud, o = fully open. cup = cross-section curvature (1/radius, units^-1). All ranges are [min,max] per petal.
 */
const WHORLS = [
  { name: 'outer', n: 5, layer: 0.0, L: [1.10, 1.24], W: [0.74, 0.88], r0: 0.15, y0: -0.03,
    t0c: [16, 22], t1c: [-46, -36], pc: 1.5, t0o: [40, 50], t1o: [70, 88], po: 1.3, curlO: [6, 14],
    cupC: [2.6, 3.2], cupO: [0.8, 1.1], twC: [0.10, 0.22], twO: [-0.12, 0.12], ruffle: [0.012, 0.03],
    tipSharp: [0.46, 0.58], start: 0.04, end: 0.58 },
  { name: 'mid', n: 6, layer: 0.34, L: [1.02, 1.16], W: [0.72, 0.84], r0: 0.135, y0: 0.0,
    t0c: [20, 26], t1c: [-50, -40], pc: 1.5, t0o: [34, 44], t1o: [60, 76], po: 1.3, curlO: [4, 10],
    cupC: [2.8, 3.4], cupO: [1.0, 1.3], twC: [0.10, 0.20], twO: [-0.10, 0.10], ruffle: [0.010, 0.026],
    tipSharp: [0.46, 0.58], start: 0.14, end: 0.70 },
  { name: 'inner', n: 6, layer: 0.67, L: [0.86, 0.98], W: [0.64, 0.74], r0: 0.12, y0: 0.02,
    t0c: [26, 32], t1c: [-56, -46], pc: 1.5, t0o: [36, 46], t1o: [62, 78], po: 1.3, curlO: [3, 9],
    cupC: [3.0, 3.6], cupO: [1.2, 1.6], twC: [0.08, 0.18], twO: [-0.08, 0.08], ruffle: [0.008, 0.02],
    tipSharp: [0.46, 0.56], start: 0.26, end: 0.84 },
  { name: 'core', n: 5, layer: 1.0, L: [0.62, 0.72], W: [0.50, 0.60], r0: 0.11, y0: 0.04,
    t0c: [26, 32], t1c: [-62, -54], pc: 1.8, t0o: [40, 50], t1o: [60, 74], po: 1.3, curlO: [0, 6],
    cupC: [3.2, 4.0], cupO: [1.5, 2.0], twC: [0.06, 0.14], twO: [-0.06, 0.06], ruffle: [0.006, 0.014],
    tipSharp: [0.46, 0.56], start: 0.38, end: 0.97 },
];

const TWO_PI = Math.PI * 2;

/** planform half-width profile, 0..1: elliptic-ovate, widest ~58%, narrow claw base, rounded-to-pointed apex */
function planform(u, tipSharp) {
  const a = Math.pow(u, 1.27);
  const b = lerp(0.62, tipSharp, smoothstep(0.30, 1.0, u));
  return Math.pow(Math.max(Math.sin(Math.PI * a), 0), b);
}

function buildPetalParams(rng) {
  const out = [];
  let idx = 0;
  const total = WHORLS.reduce((s, w) => s + w.n, 0);
  WHORLS.forEach((w, wi) => {
    const step = TWO_PI / w.n;
    const offset = rng.range(0, step) + wi * 0.5 * step;
    for (let k = 0; k < w.n; k++) {
      const r = (a) => rng.range(a[0], a[1]);
      out.push({
        index: idx++, whorl: wi, k,
        layer: w.layer,
        seed: rng.next(),
        phi: offset + k * step + rng.range(-0.16, 0.16) * step,
        L: r(w.L), W: r(w.W), tipSharp: r(w.tipSharp),
        r0: w.r0 + rng.range(-0.01, 0.01), y0: w.y0 + rng.range(-0.01, 0.01),
        t0c: r(w.t0c) * D, t1c: r(w.t1c) * D, pc: w.pc * rng.range(0.95, 1.08),
        t0o: r(w.t0o) * D, t1o: r(w.t1o) * D, po: w.po * rng.range(0.92, 1.1), curlO: r(w.curlO) * D,
        cupC: r(w.cupC), cupO: r(w.cupO), twC: r(w.twC), twO: r(w.twO), ruffle: r(w.ruffle),
        shell: lerp(0.034, 0.0, w.layer),
        start: clamp01(w.start + rng.range(-0.035, 0.035) + k * 0.012),
        end: clamp01(w.end + rng.range(-0.035, 0.035) + k * 0.008),
        flutterPhase: rng.range(0, TWO_PI), flutterFreq: rng.range(1.5, 2.6),
      });
    }
  });
  out.total = total;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------------------------------------------------
const glslCommon = (NP, NU, NS) => /* glsl */ `
#define PETAL_NP ${NP}
#define PETAL_NU ${NU}
#define PETAL_NS ${NS}
attribute float aPetal;
attribute float aLayer;
attribute float aSeed;
uniform highp sampler2D uCenA;   // (radial, vertical, theta, halfWidth) per row
uniform highp sampler2D uCenB;   // (cup, twist, ruffle amp, shell) per row
uniform vec4 uPetal[PETAL_NP];   // x azimuth, y whorl, z seed, w openness
uniform vec3 uSunDirW;

// surface point in the petal-local (radial, vertical, tangential) frame; nAx = concave-side axis in the same frame
vec3 petalEval(int pI, int row, float s, float seed, out vec3 nAx, out float cup) {
  row = clamp(row, 0, PETAL_NU);
  vec4 A = texelFetch(uCenA, ivec2(row, pI), 0);
  vec4 B = texelFetch(uCenB, ivec2(row, pI), 0);
  float th = A.z;
  float xn = 2.0 * s - 1.0;
  float x = xn * A.w;
  float c = B.x;
  float cx = c * x;
  float ob = sin(cx) / (c + 1e-4);
  float on = (1.0 - cos(cx)) / (c + 1e-4);
  float ct = cos(B.y), st = sin(B.y);
  float ob2 = ob * ct - on * st;
  float on2 = ob * st + on * ct;
  float u = float(row) / float(PETAL_NU);
  float edge = xn * xn;
  float ruf = B.z * edge * (sin(u * 11.0 + seed * 40.0 + xn * 2.0) * 0.6 + sin(u * 19.0 - xn * 3.5 + seed * 17.0) * 0.4);
  on2 += ruf - B.w;
  on2 -= B.z * 0.8 * exp(-xn * xn * 36.0);       // faint midrib: a shallow valley on the inner face (a ridge on the back)
  float ca = cos(th), sa = sin(th);
  nAx = vec3(-ca, sa, 0.0);
  cup = c;
  return vec3(A.x - ca * on2, A.y + sa * on2, ob2);
}
vec3 petalToHead(float phi, vec3 q) {
  float sp = sin(phi), cp = cos(phi);
  return vec3(q.x * sp + q.z * cp, q.y, q.x * cp - q.z * sp);
}
`;

const glslVaryings = /* glsl */ `
${PETAL_VARYINGS_GLSL}
`;

const glslMain = /* glsl */ `
  int pI = int(aPetal + 0.5);
  int pRow = int(uv.y * float(PETAL_NU) + 0.5);
  vec4 pet = uPetal[pI];
  float pPhi = pet.x;
  float pS = uv.x;
  vec3 pAx; float pCup; vec3 pTmpA; float pTmpC;
  vec3 pC = petalEval(pI, pRow, pS, pet.z, pAx, pCup);
  float dsT = 0.5 / float(PETAL_NS);
  vec3 pS0 = petalEval(pI, pRow, max(pS - dsT, 0.0), pet.z, pTmpA, pTmpC);
  vec3 pS1 = petalEval(pI, pRow, min(pS + dsT, 1.0), pet.z, pTmpA, pTmpC);
  vec3 pU0 = petalEval(pI, max(pRow - 1, 0), pS, pet.z, pTmpA, pTmpC);
  vec3 pU1 = petalEval(pI, min(pRow + 1, PETAL_NU), pS, pet.z, pTmpA, pTmpC);
  vec3 petalPos = petalToHead(pPhi, pC);
  vec3 pdS = petalToHead(pPhi, pS1 - pS0);
  vec3 pdU = petalToHead(pPhi, pU1 - pU0);
  vec3 petalNrm = cross(pdS, pdU);
  float pNL = length(petalNrm);
  vec3 pAxisHead = petalToHead(pPhi, pAx);
  petalNrm = pNL > 1e-9 ? petalNrm / pNL : pAxisHead;
  if (dot(petalNrm, pAxisHead) < 0.0) petalNrm = -petalNrm;
`;

const glslAssignVaryings = /* glsl */ `
  vPetalUv = uv;
  vPetal = vec4(aPetal, aLayer, aSeed, pet.w);
  float pMp = 1.0 - abs(2.0 * pS - 1.0);
  float pFl = pow(1.0 - smoothstep(0.0, 0.42, uv.y), 1.4);
  float pThick = mix(0.10, 0.95, pFl) * mix(0.45, 1.0, smoothstep(0.0, 0.3, pMp));
  vPetalGeo = vec3(clamp(pCup * 0.4, 0.0, 1.0), pMp, pThick);
`;

const SHADOW_ANCHOR = 'vec3 shadowWorldNormal = transformNormalByInverseViewMatrix( transformedNormal, viewMatrix );';

/**
 * @param {import('../main.js').Ctx} ctx
 * @returns {{group: Group, update(frame): void, dispose(): void, params: any[]}}
 */
export function createPetals(ctx) {
  const lod = (ctx.quality && ctx.quality.lod) || 1;
  const NU = Math.round(Math.min(Math.max(68 * lod, 32), 112));
  const NS = Math.round(Math.min(Math.max(30 * lod, 14), 48));
  const rng = ctx.rng.fork('petals');
  const params = buildPetalParams(rng);
  const NP = params.length;
  const ROWS = NU + 1;

  // ---- per-row data textures (updated every frame) -------------------------------------------------------------
  const dataA = new Float32Array(ROWS * NP * 4);
  const dataB = new Float32Array(ROWS * NP * 4);
  const mkTex = (data) => {
    const t = new DataTexture(data, ROWS, NP, RGBAFormat, FloatType);
    t.minFilter = NearestFilter; t.magFilter = NearestFilter;
    t.wrapS = ClampToEdgeWrapping; t.wrapT = ClampToEdgeWrapping;
    t.generateMipmaps = false; t.flipY = false; t.needsUpdate = true;
    return t;
  };
  const texA = mkTex(dataA);
  const texB = mkTex(dataB);

  const uPetal = { value: params.map((p) => new Vector4(p.phi, p.layer, p.seed, 0)) };
  const shared = {
    uCenA: { value: texA },
    uCenB: { value: texB },
    uPetal,
    uSunDirW: { value: ctx.sun.direction },
  };

  // ---- geometry: one merged grid mesh, deformed entirely in the vertex stage ----------------------------------
  const cols = NS + 1;
  const vPer = cols * ROWS;
  const nVert = vPer * NP;
  const pos = new Float32Array(nVert * 3);
  const nor = new Float32Array(nVert * 3);
  const uvs = new Float32Array(nVert * 2);
  const aP = new Float32Array(nVert);
  const aL = new Float32Array(nVert);
  const aS = new Float32Array(nVert);
  for (let p = 0; p < NP; p++) {
    const pr = params[p];
    for (let r = 0; r < ROWS; r++) {
      const u = r / NU;
      const hw = 0.5 * pr.W * planform(u, pr.tipSharp);
      for (let c = 0; c < cols; c++) {
        const s = c / NS;
        const i = p * vPer + r * cols + c;
        pos[i * 3] = (s - 0.5) * 2 * hw; pos[i * 3 + 1] = u * pr.L; pos[i * 3 + 2] = 0;   // placeholder (bounds only)
        nor[i * 3 + 2] = 1;
        uvs[i * 2] = s; uvs[i * 2 + 1] = u;
        aP[i] = p; aL[i] = pr.layer; aS[i] = pr.seed;
      }
    }
  }
  const quadCount = NS * NU;
  const idxArr = nVert > 65535 ? new Uint32Array(NP * quadCount * 6) : new Uint16Array(NP * quadCount * 6);
  let ii = 0;
  for (let p = 0; p < NP; p++) {
    const base = p * vPer;
    for (let r = 0; r < NU; r++) {
      for (let c = 0; c < NS; c++) {
        const a = base + r * cols + c, b = a + 1, cc = a + cols, d = cc + 1;
        // front face = concave side (see header): (a, c, b) and (b, c, d)
        idxArr[ii++] = a; idxArr[ii++] = cc; idxArr[ii++] = b;
        idxArr[ii++] = b; idxArr[ii++] = cc; idxArr[ii++] = d;
      }
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geo.setAttribute('aPetal', new Float32BufferAttribute(aP, 1));
  geo.setAttribute('aLayer', new Float32BufferAttribute(aL, 1));
  geo.setAttribute('aSeed', new Float32BufferAttribute(aS, 1));
  geo.setIndex(nVert > 65535 ? new Uint32BufferAttribute(idxArr, 1) : new Uint16BufferAttribute(idxArr, 1));
  geo.boundingSphere = new Sphere(new Vector3(0, 0.6, 0), 2.2);

  // ---- materials ---------------------------------------------------------------------------------------------
  const skin = createPetalSkin(ctx);
  const material = skin.material;
  const keyBase = `petal-form-v1-${NP}-${NU}-${NS}`;
  addPatch(material, {
    key: keyBase,
    uniforms: shared,
    vertex: (v) => {
      v = inject(v, 'common', glslCommon(NP, NU, NS) + glslVaryings);
      v = inject(v, 'beginnormal_vertex', glslMain + glslAssignVaryings, 'before');
      v = inject(v, 'beginnormal_vertex', 'objectNormal = petalNrm;');
      v = inject(v, 'begin_vertex', 'transformed = petalPos;');
      // thin double-sided sheets: bias along the face that FACES the light, or back-lit petals self-shadow
      v = replaceOnce(v, '#include <shadowmap_vertex>', ShaderChunk.shadowmap_vertex.replace(
        SHADOW_ANCHOR,
        `${SHADOW_ANCHOR}\n\t\tshadowWorldNormal *= ( dot( shadowWorldNormal, uSunDirW ) >= 0.0 ) ? 1.0 : - 1.0;`));
      return v;
    },
  });

  const depthMaterial = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  addPatch(depthMaterial, {
    key: keyBase + '-depth',
    uniforms: shared,
    vertex: (v) => {
      v = inject(v, 'common', glslCommon(NP, NU, NS));
      v = inject(v, 'begin_vertex', `
        int pI = int(aPetal + 0.5);
        int pRow = int(uv.y * float(PETAL_NU) + 0.5);
        vec4 pet = uPetal[pI];
        vec3 pAx; float pCup;
        transformed = petalToHead(pet.x, petalEval(pI, pRow, uv.x, pet.z, pAx, pCup));`);
      return v;
    },
  });

  const mesh = new Mesh(geo, material);
  mesh.name = 'petals';
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.customDepthMaterial = depthMaterial;
  const group = new Group();
  group.name = 'petals';
  group.add(mesh);

  // ---- per-frame update ---------------------------------------------------------------------------------------
  const easeIO = (x) => x * x * (3 - 2 * x);
  function update(frame) {
    const bloom = frame.bloom;
    const t = frame.time;
    const windMag = Math.min(1, Math.hypot(frame.wind.x, frame.wind.z));
    let outerR = 0, outerN = 0;
    for (let i = 0; i < NP; i++) {
      const P = params[i];
      const x = clamp01((bloom - P.start) / (P.end - P.start));
      const o = easeIO(x);
      const oBase = smoothstep(0.2, 1.0, o);
      const oTip = smoothstep(0.0, 0.75, o);
      const oCup = smoothstep(0.05, 0.95, o);
      const t0 = lerp(P.t0c, P.t0o, oBase);
      const t1 = lerp(P.t1c, P.t1o, oTip);
      const pw = lerp(P.pc, P.po, o);
      const curl = P.curlO * oTip;
      const cup = lerp(P.cupC, P.cupO, oCup);
      const tw = lerp(P.twC, P.twO, o);
      const breath = Math.sin(t * 0.7 + P.phi) * 0.012 * o;
      const flut = (0.010 + 0.03 * windMag) * Math.sin(t * P.flutterFreq + P.flutterPhase) * o + breath;
      const ruf = P.ruffle * (0.35 + 0.65 * o);

      let r = P.r0, y = P.y0;
      const row0 = i * ROWS * 4;
      const stepL = P.L / NU;
      let maxR = 0;
      for (let k = 0; k <= NU; k++) {
        const u = k / NU;
        const sm = clamp01((u - 0.55) / 0.45);
        const th = t0 + (t1 - t0) * Math.pow(u, pw) + curl * sm * sm + flut * u * u;
        const j = row0 + k * 4;
        dataA[j] = r; dataA[j + 1] = y; dataA[j + 2] = th;
        dataA[j + 3] = 0.5 * P.W * planform(u, P.tipSharp);
        dataB[j] = cup * (0.45 + 0.55 * Math.sin(Math.PI * Math.pow(u, 0.8)));
        dataB[j + 1] = tw * Math.pow(u, 1.3);
        dataB[j + 2] = ruf * smoothstep(0.15, 0.9, u);
        dataB[j + 3] = P.shell;
        if (r > maxR) maxR = r;
        if (k < NU) {
          const um = (k + 0.5) / NU;
          const sm2 = clamp01((um - 0.55) / 0.45);
          const thm = t0 + (t1 - t0) * Math.pow(um, pw) + curl * sm2 * sm2 + flut * um * um;
          r += Math.sin(thm) * stepL;
          y += Math.cos(thm) * stepL;
        }
      }
      if (P.whorl === 0) { outerR += maxR; outerN++; }
      uPetal.value[i].w = o;
    }
    texA.needsUpdate = true;
    texB.needsUpdate = true;
    if (outerN) frame.flowerRadius = outerR / outerN;
    skin.update(frame);
  }

  function dispose() {
    geo.dispose(); texA.dispose(); texB.dispose(); depthMaterial.dispose(); skin.dispose();
  }

  return { group, update, dispose, params, mesh };
}
