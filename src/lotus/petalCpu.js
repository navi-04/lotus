/**
 * CPU petals - the last resort. The same surface as the GPU paths, but evaluated in JavaScript into ordinary position / normal buffers
 * and drawn with a stock MeshStandardMaterial (vertex colours): no custom shader, no vertex texture, no instancing. Anything the stem and
 * the seed pod can draw, this can draw. Coarser (about 17k vertices) and a little flatter-looking, but it is a flower rather than a bare pod.
 */
import {
  BufferGeometry, BufferAttribute, Float32BufferAttribute, Uint16BufferAttribute, DynamicDrawUsage, Mesh, MeshStandardMaterial, DoubleSide, Color, Sphere, Vector3,
} from 'three';
import { PALETTE } from '../core/constants.js';
import { smoothstep } from '../core/timeline.js';
import { createRowIntegrator } from './petalShape.js';

/** the inner-face colour ramp of petalSkin.js, in linear space, for one point of a petal */
function makeRamp() {
  const c0 = new Color(PALETTE.petalBase), c1 = new Color('#f8f4de'), c2 = new Color('#f9d3df'), c3 = new Color('#f09ac0'), c4 = new Color('#d4467f');
  const tmp = new Color();
  return (u, pink, out) => {
    out.copy(c0);
    out.lerp(c1, smoothstep(0.00, 0.26, u));
    out.lerp(c2, smoothstep(0.16, 0.46, u));
    out.lerp(tmp.copy(c3), smoothstep(0.30, 0.80, u) * Math.min(pink, 1));
    out.lerp(tmp.copy(c4), smoothstep(0.74, 1.00, u) * Math.min(pink, 1));
    return out;
  };
}

/**
 * @param {import('../main.js').Ctx} ctx
 * @param {any[]} params  petalShape.buildPetalParams()
 * @param {{NU: number, NS: number}} opt
 */
export function createCpuVariant(ctx, params, { NU, NS }) {
  const NP = params.length;
  const ROWS = NU + 1;
  const cols = NS + 1;
  const vPer = cols * ROWS;
  const nVert = vPer * NP;
  const integ = createRowIntegrator(params, NU);

  const pos = new Float32Array(nVert * 3);
  const nor = new Float32Array(nVert * 3);
  const col = new Float32Array(nVert * 3);
  const ramp = makeRamp();
  const tint = new Color();
  for (let p = 0; p < NP; p++) {
    const pr = params[p];
    const pink = Math.min(Math.max((0.80 + 0.38 * pr.seed) * (1.12 - 0.28 * pr.layer), 0.5), 1.25);
    for (let r = 0; r < ROWS; r++) {
      const u = r / NU;
      for (let c = 0; c < cols; c++) {
        const e = Math.abs(2 * (c / NS) - 1);
        ramp(Math.min(Math.max(u + e * 0.07 * smoothstep(0.3, 0.9, u), 0), 1), pink, tint);
        const i = (p * vPer + r * cols + c) * 3;
        col[i] = tint.r; col[i + 1] = tint.g; col[i + 2] = tint.b;
      }
    }
  }

  const idx = new Uint16Array(NP * NS * NU * 6);
  let ii = 0;
  for (let p = 0; p < NP; p++) {
    const base = p * vPer;
    for (let r = 0; r < NU; r++) {
      for (let c = 0; c < NS; c++) {
        const a = base + r * cols + c, b = a + 1, cc = a + cols, d = cc + 1;
        idx[ii++] = a; idx[ii++] = cc; idx[ii++] = b;      // front face = concave side, as in the GPU paths
        idx[ii++] = b; idx[ii++] = cc; idx[ii++] = d;
      }
    }
  }

  const geo = new BufferGeometry();
  // BufferAttribute (not Float32BufferAttribute, which copies its input) so the arrays written every frame ARE the attribute's arrays
  const posAttr = new BufferAttribute(pos, 3).setUsage(DynamicDrawUsage);
  const norAttr = new BufferAttribute(nor, 3).setUsage(DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('normal', norAttr);
  geo.setAttribute('color', new Float32BufferAttribute(col, 3));
  geo.setIndex(new Uint16BufferAttribute(idx, 1));
  geo.boundingSphere = new Sphere(new Vector3(0, 0.6, 0), 2.2);

  const material = new MeshStandardMaterial({
    vertexColors: true, roughness: 0.55, metalness: 0, side: DoubleSide,
    emissive: new Color('#8a4a64'), emissiveIntensity: 0.34,       // stands in for the light that glows through a thin petal
  });
  const mesh = new Mesh(geo, material);
  mesh.name = 'petals';
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  function surface(frame) {
    integ.step(frame);
    const { dataA, dataB } = integ;
    for (let p = 0; p < NP; p++) {
      const pr = params[p];
      const seed = pr.seed;
      const sp = Math.sin(pr.phi), cp = Math.cos(pr.phi);
      for (let r = 0; r < ROWS; r++) {
        const j = (p * ROWS + r) * 4;
        const radial = dataA[j], vert = dataA[j + 1], th = dataA[j + 2], hw = dataA[j + 3];
        const cup = dataB[j], tw = dataB[j + 1], ruf = dataB[j + 2], shell = dataB[j + 3];
        const ct = Math.cos(tw), st = Math.sin(tw), ca = Math.cos(th), sa = Math.sin(th);
        const u = r / NU;
        const k1 = u * 11 + seed * 40, k2 = u * 19 + seed * 17;
        for (let c = 0; c < cols; c++) {
          const xn = 2 * (c / NS) - 1;
          const cx = cup * xn * hw;
          const inv = 1 / (cup + 1e-4);
          const ob = Math.sin(cx) * inv, on = (1 - Math.cos(cx)) * inv;
          const ob2 = ob * ct - on * st;
          let on2 = ob * st + on * ct;
          const edge = xn * xn;
          on2 += ruf * edge * (Math.sin(k1 + xn * 2) * 0.6 + Math.sin(k2 - xn * 3.5) * 0.4) - shell;
          on2 -= ruf * 0.8 * Math.exp(-xn * xn * 36);
          const qx = radial - ca * on2, qy = vert + sa * on2, qz = ob2;
          const i = (p * vPer + r * cols + c) * 3;
          pos[i] = qx * sp + qz * cp; pos[i + 1] = qy; pos[i + 2] = qx * cp - qz * sp;
        }
      }
      // normals from the neighbouring grid points, turned to the concave side (the way the GPU paths do)
      for (let r = 0; r < ROWS; r++) {
        const j = (p * ROWS + r) * 4;
        const th = dataA[j + 2];
        const ax = -Math.cos(th) * sp, ay = Math.sin(th), az = -Math.cos(th) * cp;
        const r0 = Math.max(r - 1, 0), r1 = Math.min(r + 1, NU);
        for (let c = 0; c < cols; c++) {
          const c0 = Math.max(c - 1, 0), c1 = Math.min(c + 1, NS);
          const base = p * vPer;
          const sA = (base + r * cols + c1) * 3, sB = (base + r * cols + c0) * 3;
          const uA = (base + r1 * cols + c) * 3, uB = (base + r0 * cols + c) * 3;
          const sx = pos[sA] - pos[sB], sy = pos[sA + 1] - pos[sB + 1], sz = pos[sA + 2] - pos[sB + 2];
          const ux = pos[uA] - pos[uB], uy = pos[uA + 1] - pos[uB + 1], uz = pos[uA + 2] - pos[uB + 2];
          let nx = sy * uz - sz * uy, ny = sz * ux - sx * uz, nz = sx * uy - sy * ux;
          const len = Math.hypot(nx, ny, nz);
          if (len > 1e-9) { nx /= len; ny /= len; nz /= len; } else { nx = ax; ny = ay; nz = az; }
          if (nx * ax + ny * ay + nz * az < 0) { nx = -nx; ny = -ny; nz = -nz; }
          const i = (base + r * cols + c) * 3;
          nor[i] = nx; nor[i + 1] = ny; nor[i + 2] = nz;
        }
      }
    }
    posAttr.needsUpdate = true;
    norAttr.needsUpdate = true;
  }

  return {
    mesh,
    info: { vertices: nVert, triangles: NP * NS * NU * 2, NU, NS },
    update: surface,
    dispose() { geo.dispose(); material.dispose(); },
  };
}
