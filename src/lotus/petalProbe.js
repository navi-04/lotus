/**
 * Petal probe - proves the petals really draw on this GPU.
 *
 * Draws ONLY the petal mesh (a spare camera layer keeps everything else out; the lights join that layer so the very same shader
 * programs are used) from the side into a 64 x 64 hidden image and counts the pixels it covers. The real flower always covers a good
 * share of that image, even as a closed bud, so a count near zero means the GPU dropped the draw. One draw and one read-back, once.
 * Used by petals.js to walk down the ladder in petalLadder.js.
 */
import { WebGLRenderTarget, PerspectiveCamera, Vector3, Color, UnsignedByteType, RGBAFormat, NearestFilter } from 'three';

const LAYER = 5;
const SIZE = 64;

/** @returns {{ run(mesh: import('three').Mesh, anchor: import('three').Object3D): number, dispose(): void }} */
export function createPetalProbe(renderer, scene) {
  const rt = new WebGLRenderTarget(SIZE, SIZE, { type: UnsignedByteType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: true, samples: 0 });
  const cam = new PerspectiveCamera(40, 1, 0.1, 60);
  cam.layers.set(LAYER);
  const buf = new Uint8Array(SIZE * SIZE * 4);
  const clear = new Color();
  const at = new Vector3();
  const axis = new Vector3();

  function run(mesh, anchor) {
    scene.traverse((o) => { if (o.isLight) o.layers.enable(LAYER); });
    mesh.layers.enable(LAYER);

    // look at the middle of the flower head from the side, far enough back to hold a fully open flower
    anchor.updateWorldMatrix(true, false);
    anchor.getWorldPosition(at);
    axis.set(0, 1, 0).transformDirection(anchor.matrixWorld);
    at.addScaledVector(axis, 0.6);
    cam.position.copy(at).add(axis.set(0, 0.6, 4.3));
    cam.lookAt(at);
    cam.updateMatrixWorld(true);

    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(clear);
    const prevBg = scene.background;
    let px = 0;
    try {
      scene.background = null;
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = true;
      renderer.render(scene, cam);
      renderer.readRenderTargetPixels(rt, 0, 0, SIZE, SIZE, buf);
      for (let i = 3; i < buf.length; i += 4) if (buf[i] > 16) px++;
    } finally {
      scene.background = prevBg;
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAuto;
      renderer.setClearColor(clear, prevAlpha);
      mesh.layers.disable(LAYER);
    }
    return px;
  }

  return { run, dispose() { rt.dispose(); } };
}
