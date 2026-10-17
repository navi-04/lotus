/**
 * GPU petals - the surface is built in the vertex stage from the per-row tables of petalShape.js. Two ways to hand those tables over:
 *
 *   tex   - two small float textures read with texelFetch (one merged grid mesh). Cheapest; what desktops use.
 *   inst  - the same numbers as INSTANCED vertex attributes: one instance per petal row (a two-row strip), carrying the four rows around it.
 *           No vertex texture fetch and no dynamic indexing of a uniform array, so it runs where those misbehave.
 *
 * Both run the identical surface maths (petalEvalRow), so the flower is the same. Either can wear the full petal skin or the lite one.
 * GPU side per vertex: ~16 trig ops, normals by central differences. Winding: gl_FrontFacing == concave (inner/upper) face
 * (see petalContract.js). Material: petalSkin.js.
 */
import {
  BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute, Uint16BufferAttribute, InstancedBufferGeometry, InstancedBufferAttribute,
  DynamicDrawUsage, Mesh, Sphere, Vector3, Vector4, DataTexture, RGBAFormat, FloatType, NearestFilter, ClampToEdgeWrapping,
  MeshDepthMaterial, RGBADepthPacking, ShaderChunk,
} from 'three';
import { addPatch, inject, replaceOnce } from '../core/shaderPatch.js';
import { PETAL_VARYINGS_GLSL } from './petalContract.js';
import { createPetalSkin } from './petalSkin.js';
import { planform, createRowIntegrator } from './petalShape.js';

// ---------------------------------------------------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------------------------------------------------
/** the surface maths, shared by both data paths: one point of the petal from its row tables A, B */
const glslMath = (NP, NU, NS) => /* glsl */ `
#define PETAL_NP ${NP}
#define PETAL_NU ${NU}
#define PETAL_NS ${NS}
uniform vec3 uSunDirW;

// surface point in the petal-local (radial, vertical, tangential) frame; nAx = concave-side axis in the same frame
// A = (radial, vertical, theta, halfWidth)   B = (cup, twist, ruffle amp, shell)   rowF = this row's index (for the ruffle phase)
vec3 petalEvalRow(vec4 A, vec4 B, float rowF, float s, float seed, out vec3 nAx, out float cup) {
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
  float u = rowF / float(PETAL_NU);
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

const glslDeclTex = /* glsl */ `
attribute float aPetal;
attribute float aLayer;
attribute float aSeed;
uniform highp sampler2D uCenA;   // (radial, vertical, theta, halfWidth) per row
uniform highp sampler2D uCenB;   // (cup, twist, ruffle amp, shell) per row
uniform vec4 uPetal[PETAL_NP];   // x azimuth, y whorl, z seed, w openness
vec3 petalEval(int pI, int row, float s, float seed, out vec3 nAx, out float cup) {
  row = clamp(row, 0, PETAL_NU);
  vec4 A = texelFetch(uCenA, ivec2(row, pI), 0);
  vec4 B = texelFetch(uCenB, ivec2(row, pI), 0);
  return petalEvalRow(A, B, float(row), s, seed, nAx, cup);
}
`;

const glslDeclInst = /* glsl */ `
attribute vec4 aInst;                                   // x petal index, y row r: this strip runs from row r to row r + 1
attribute vec4 aPet;                                    // x azimuth, y whorl, z seed, w openness
attribute vec4 aA0; attribute vec4 aA1; attribute vec4 aA2; attribute vec4 aA3;   // table A for rows r-1 .. r+2 (clamped to the petal)
attribute vec4 aB0; attribute vec4 aB1; attribute vec4 aB2; attribute vec4 aB3;   // table B for the same rows
`;

const glslVaryings = /* glsl */ `
${PETAL_VARYINGS_GLSL}
`;

/** from the five surface samples to position and normal; identical for both data paths */
const glslFinish = /* glsl */ `
  vec3 petalPos = petalToHead(pPhi, pC);
  vec3 pdS = petalToHead(pPhi, pS1 - pS0);
  vec3 pdU = petalToHead(pPhi, pU1 - pU0);
  vec3 petalNrm = cross(pdS, pdU);
  float pNL = length(petalNrm);
  vec3 pAxisHead = petalToHead(pPhi, pAx);
  petalNrm = pNL > 1e-9 ? petalNrm / pNL : pAxisHead;
  if (dot(petalNrm, pAxisHead) < 0.0) petalNrm = -petalNrm;
`;

const glslMainTex = /* glsl */ `
  int pI = int(aPetal + 0.5);
  int pRow = int(uv.y * float(PETAL_NU) + 0.5);
  vec2 pUV = uv;
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
${glslFinish}`;

const glslMainInst = /* glsl */ `
  float pRowF = aInst.y + uv.y;                           // uv.y: 0 = the strip's first row, 1 = its second
  vec2 pUV = vec2(uv.x, pRowF / float(PETAL_NU));
  bool pSecond = uv.y > 0.5;
  vec4 pAm = pSecond ? aA1 : aA0;
  vec4 pA0 = pSecond ? aA2 : aA1;
  vec4 pAp = pSecond ? aA3 : aA2;
  vec4 pBm = pSecond ? aB1 : aB0;
  vec4 pB0 = pSecond ? aB2 : aB1;
  vec4 pBp = pSecond ? aB3 : aB2;
  vec4 pet = aPet;
  float pPhi = pet.x;
  float pS = uv.x;
  vec3 pAx; float pCup; vec3 pTmpA; float pTmpC;
  vec3 pC = petalEvalRow(pA0, pB0, pRowF, pS, pet.z, pAx, pCup);
  float dsT = 0.5 / float(PETAL_NS);
  vec3 pS0 = petalEvalRow(pA0, pB0, pRowF, max(pS - dsT, 0.0), pet.z, pTmpA, pTmpC);
  vec3 pS1 = petalEvalRow(pA0, pB0, pRowF, min(pS + dsT, 1.0), pet.z, pTmpA, pTmpC);
  vec3 pU0 = petalEvalRow(pAm, pBm, max(pRowF - 1.0, 0.0), pS, pet.z, pTmpA, pTmpC);
  vec3 pU1 = petalEvalRow(pAp, pBp, min(pRowF + 1.0, float(PETAL_NU)), pS, pet.z, pTmpA, pTmpC);
${glslFinish}`;

const glslAssignVaryings = (idx, layer, seed) => /* glsl */ `
  vPetalUv = pUV;
  vPetal = vec4(${idx}, ${layer}, ${seed}, pet.w);
  float pMp = 1.0 - abs(2.0 * pS - 1.0);
  float pFl = pow(1.0 - smoothstep(0.0, 0.42, pUV.y), 1.4);
  float pThick = mix(0.10, 0.95, pFl) * mix(0.45, 1.0, smoothstep(0.0, 0.3, pMp));
  vPetalGeo = vec3(clamp(pCup * 0.4, 0.0, 1.0), pMp, pThick);
`;

const glslDepthTex = /* glsl */ `
  int pI = int(aPetal + 0.5);
  int pRow = int(uv.y * float(PETAL_NU) + 0.5);
  vec4 pet = uPetal[pI];
  vec3 pAx; float pCup;
  transformed = petalToHead(pet.x, petalEval(pI, pRow, uv.x, pet.z, pAx, pCup));`;

const glslDepthInst = /* glsl */ `
  bool pSecond = uv.y > 0.5;
  vec4 pA0 = pSecond ? aA2 : aA1;
  vec4 pB0 = pSecond ? aB2 : aB1;
  vec4 pet = aPet;
  vec3 pAx; float pCup;
  transformed = petalToHead(pet.x, petalEvalRow(pA0, pB0, aInst.y + uv.y, uv.x, pet.z, pAx, pCup));`;

const SHADOW_ANCHOR = 'vec3 shadowWorldNormal = transformNormalByInverseViewMatrix( transformedNormal, viewMatrix );';

// ---------------------------------------------------------------------------------------------------------------------
// variant
// ---------------------------------------------------------------------------------------------------------------------
/**
 * @param {import('../main.js').Ctx} ctx
 * @param {any[]} params  petalShape.buildPetalParams()
 * @param {{instanced: boolean, lite: boolean, NU: number, NS: number}} opt
 */
export function createGpuVariant(ctx, params, { instanced, lite, NU, NS }) {
  const NP = params.length;
  const ROWS = NU + 1;
  const integ = createRowIntegrator(params, NU);
  const cols = NS + 1;

  const shared = { uSunDirW: { value: ctx.sun.direction } };
  let geo, vertexCount, triangleCount, writeTables;

  if (!instanced) {
    // ---- tables as two float textures (rewritten every frame) ---------------------------------------------------
    const mkTex = (data) => {
      const t = new DataTexture(data, ROWS, NP, RGBAFormat, FloatType);
      t.minFilter = NearestFilter; t.magFilter = NearestFilter;
      t.wrapS = ClampToEdgeWrapping; t.wrapT = ClampToEdgeWrapping;
      t.generateMipmaps = false; t.flipY = false; t.needsUpdate = true;
      return t;
    };
    const texA = mkTex(integ.dataA);
    const texB = mkTex(integ.dataB);
    const uPetal = { value: params.map((p) => new Vector4(p.phi, p.layer, p.seed, 0)) };
    shared.uCenA = { value: texA };
    shared.uCenB = { value: texB };
    shared.uPetal = uPetal;
    writeTables = () => {
      for (let i = 0; i < NP; i++) uPetal.value[i].w = integ.open[i];
      texA.needsUpdate = true;
      texB.needsUpdate = true;
    };

    // ---- one merged grid mesh, deformed entirely in the vertex stage -------------------------------------------
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
    const idxArr = nVert > 65535 ? new Uint32Array(NP * NS * NU * 6) : new Uint16Array(NP * NS * NU * 6);
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
    geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    geo.setAttribute('aPetal', new Float32BufferAttribute(aP, 1));
    geo.setAttribute('aLayer', new Float32BufferAttribute(aL, 1));
    geo.setAttribute('aSeed', new Float32BufferAttribute(aS, 1));
    geo.setIndex(nVert > 65535 ? new Uint32BufferAttribute(idxArr, 1) : new Uint16BufferAttribute(idxArr, 1));
    vertexCount = nVert;
    triangleCount = NP * NS * NU * 2;
  } else {
    // ---- one instance per petal row: a two-row strip that carries the four table rows around it --------------------
    geo = new InstancedBufferGeometry();
    const pos = new Float32Array(2 * cols * 3);
    const nor = new Float32Array(2 * cols * 3);
    const uvs = new Float32Array(2 * cols * 2);
    for (let side = 0; side < 2; side++) {
      for (let c = 0; c < cols; c++) {
        const i = side * cols + c;
        pos[i * 3] = (c / NS - 0.5) * 0.4; pos[i * 3 + 1] = side * 0.05;     // placeholder (bounds only)
        nor[i * 3 + 2] = 1;
        uvs[i * 2] = c / NS; uvs[i * 2 + 1] = side;
      }
    }
    const idx = new Uint16Array(NS * 6);
    for (let c = 0, k = 0; c < NS; c++) {
      const a = c, b = c + 1, cc = cols + c, d = cc + 1;
      idx[k++] = a; idx[k++] = cc; idx[k++] = b;
      idx[k++] = b; idx[k++] = cc; idx[k++] = d;
    }
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    geo.setIndex(new Uint16BufferAttribute(idx, 1));

    const count = NP * NU;
    const inst = (name, dynamic) => {
      const a = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
      if (dynamic) a.setUsage(DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a;
    };
    const aInst = inst('aInst', false);
    const aPet = inst('aPet', true);
    const tabA = [inst('aA0', true), inst('aA1', true), inst('aA2', true), inst('aA3', true)];
    const tabB = [inst('aB0', true), inst('aB1', true), inst('aB2', true), inst('aB3', true)];
    for (let p = 0; p < NP; p++) {
      for (let r = 0; r < NU; r++) {
        const k = (p * NU + r) * 4;
        aInst.array[k] = p; aInst.array[k + 1] = r;
        aPet.array[k] = params[p].phi; aPet.array[k + 1] = params[p].layer; aPet.array[k + 2] = params[p].seed;
      }
    }
    geo.instanceCount = count;
    writeTables = () => {
      const { dataA, dataB, open } = integ;
      for (let p = 0; p < NP; p++) {
        const o = open[p];
        for (let r = 0; r < NU; r++) {
          const k = (p * NU + r) * 4;
          aPet.array[k + 3] = o;
          for (let j = 0; j < 4; j++) {
            const row = Math.min(Math.max(r - 1 + j, 0), NU);        // rows r-1 .. r+2, clamped to the petal
            const src = (p * ROWS + row) * 4;
            const a = tabA[j].array, b = tabB[j].array;
            a[k] = dataA[src]; a[k + 1] = dataA[src + 1]; a[k + 2] = dataA[src + 2]; a[k + 3] = dataA[src + 3];
            b[k] = dataB[src]; b[k + 1] = dataB[src + 1]; b[k + 2] = dataB[src + 2]; b[k + 3] = dataB[src + 3];
          }
        }
      }
      aPet.needsUpdate = true;
      for (let j = 0; j < 4; j++) { tabA[j].needsUpdate = true; tabB[j].needsUpdate = true; }
    };
    vertexCount = 2 * cols * count;
    triangleCount = NS * 2 * count;
  }
  geo.boundingSphere = new Sphere(new Vector3(0, 0.6, 0), 2.2);

  // ---- materials ---------------------------------------------------------------------------------------------
  const skin = createPetalSkin(ctx, { lite });
  const material = skin.material;
  const keyBase = `petal-form-v2-${instanced ? 'inst' : 'tex'}-${NP}-${NU}-${NS}`;
  const decl = instanced ? glslDeclInst : glslDeclTex;
  addPatch(material, {
    key: keyBase,
    uniforms: shared,
    vertex: (v) => {
      v = inject(v, 'common', glslMath(NP, NU, NS) + decl + glslVaryings);
      v = inject(v, 'beginnormal_vertex', (instanced ? glslMainInst : glslMainTex)
        + (instanced ? glslAssignVaryings('aInst.x', 'pet.y', 'pet.z') : glslAssignVaryings('aPetal', 'aLayer', 'aSeed')), 'before');
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
      v = inject(v, 'common', glslMath(NP, NU, NS) + decl);
      v = inject(v, 'begin_vertex', instanced ? glslDepthInst : glslDepthTex);
      return v;
    },
  });

  const mesh = new Mesh(geo, material);
  mesh.name = 'petals';
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.customDepthMaterial = depthMaterial;

  return {
    mesh,
    info: { vertices: vertexCount, triangles: triangleCount, NU, NS },
    update(frame) {
      integ.step(frame);
      writeTables();
      skin.update(frame);
    },
    dispose() {
      geo.dispose(); depthMaterial.dispose(); skin.dispose();
      if (shared.uCenA) { shared.uCenA.value.dispose(); shared.uCenB.value.dispose(); }
    },
  };
}
