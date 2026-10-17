/**
 * Petals - ~22 parametric petals in 4 whorls that unfurl as the bloom progresses.
 *
 * Shape (petalShape.js): per frame, the CPU integrates each petal's inextensible CENTRE LINE from a bending-angle law into two small
 * per-row tables. Drawing (this file picks the way): the tables go to the GPU - as float textures, or as instanced vertex attributes -
 * where the vertex stage builds the cupped, twisted, ruffled surface and its normals; or, on a GPU that refuses both, JavaScript builds
 * the surface and a stock material draws it. Every way makes the same flower; see petalLadder.js for how the app proves one works.
 */
import { Group } from 'three';
import { buildPetalParams } from './petalShape.js';
import { createGpuVariant } from './petalGpu.js';
import { createCpuVariant } from './petalCpu.js';
import { createPetalProbe } from './petalProbe.js';
import { RUNGS, MIN_PIXELS, parseForced, readStart, writeRung, settleLadder } from './petalLadder.js';
import { local } from '../core/storage.js';

/**
 * @param {import('../main.js').Ctx} ctx
 * @returns {{group: Group, update(frame): void, dispose(): void, params: any[], mesh: any, rung: string, info: any,
 *            settle(env: object): Promise<object>}}
 */
export function createPetals(ctx) {
  const mobile = !!(ctx.quality && ctx.quality.isMobile);
  // a phone screen never shows the ultra density, and a lighter draw is one more thing a small GPU cannot choke on
  const lod = Math.min((ctx.quality && ctx.quality.lod) || 1, mobile ? 1.0 : 1.4);
  const NU = Math.round(Math.min(Math.max(68 * lod, 32), 112));
  const NS = Math.round(Math.min(Math.max(30 * lod, 14), 48));
  const params = buildPetalParams(ctx.rng.fork('petals'));

  const make = {
    tex: () => createGpuVariant(ctx, params, { instanced: false, lite: false, NU, NS }),
    inst: () => createGpuVariant(ctx, params, { instanced: true, lite: false, NU, NS }),
    instlite: () => createGpuVariant(ctx, params, { instanced: true, lite: true, NU, NS }),
    cpu: () => createCpuVariant(ctx, params, { NU: 44, NS: 16 }),
  };
  const raw = ctx.params && ctx.params.raw;
  const forced = parseForced(raw && raw.get('petals'));                                          // ?petals=tex|inst|instlite|cpu
  const broken = new Set(((raw && raw.get('breakpetals')) || '').split(',').map((s) => s.trim()).filter(Boolean));   // test hook, see mount()

  const group = new Group();
  group.name = 'petals';
  let variant = null;
  let lastFrame = null;

  function mount(id) {
    if (variant) { group.remove(variant.mesh); variant.dispose(); variant = null; }
    variant = make[id]();
    if (broken.has(id)) variant.mesh.visible = false;      // test hook: pretend this rung's draw is dropped, to exercise the ladder
    group.add(variant.mesh);
    api.mesh = variant.mesh;
    api.rung = id;
    api.info = variant.info;
    if (lastFrame) variant.update(lastFrame);
  }

  /**
   * Prove the petals draw here, and swap in a simpler rung if they do not. Call once the scene is assembled, before the first frame shows.
   * @param {{renderer: any, scene: any, anchor?: any, compile?: () => Promise<void>, log?: (...a: any[]) => void}} env
   */
  async function settle({ renderer, scene, anchor, compile = async () => {}, log = () => {} }) {
    const probe = createPetalProbe(renderer, scene);
    try {
      const measure = async (id) => {
        await compile();
        const t0 = performance.now();
        const px = probe.run(variant.mesh, anchor || group);
        log(`petal probe: ${id} covers ${px} px (${(performance.now() - t0).toFixed(1)} ms)`);
        return px;
      };
      if (forced) {                                         // a pinned rung is measured and reported, never swapped
        const px = await measure(forced);
        return { id: forced, forced: true, ok: px >= MIN_PIXELS, tried: [{ id: forced, px, ok: px >= MIN_PIXELS, err: null }] };
      }
      const start = readStart(local);
      const res = await settleLadder({ start, build: (id) => { if (id !== api.rung) mount(id); }, probe: measure });
      if (res.ok && res.id !== RUNGS[start]) writeRung(local, res.id);   // only a change is written, so a note's week is never renewed by merely working
      else if (!res.ok) mount(RUNGS[start]);                             // nothing passed - the check itself may be wrong, so go back to where we began
      return { ...res, forced: false, id: res.ok ? res.id : api.rung };
    } finally {
      probe.dispose();
    }
  }

  function update(frame) {
    lastFrame = frame;
    variant.update(frame);
  }

  function dispose() {
    if (variant) { group.remove(variant.mesh); variant.dispose(); variant = null; }
  }

  const api = { group, update, dispose, params, mesh: null, rung: null, info: null, settle };
  mount(forced || RUNGS[readStart(local)]);
  return api;
}
