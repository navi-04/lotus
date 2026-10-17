/**
 * Petal watch - the second opinion from the real, fully composed frame.
 *
 * The startup probe (petalProbe.js) draws the petals alone. This asks the GPU, through an occlusion query wrapped around the petal draw
 * of the main camera, whether any pixel of the petals really got through in the live frames. If the petals are in view for a stretch of
 * frames and not one pixel passes, they are not showing, whatever the probe said, and the controller moves a rung down.
 * Conservative on purpose: it only judges while the flower is above the water and inside the view, needs a long run of frames, and the
 * first pixel that passes ends the watch for good.
 */
import { Frustum, Matrix4, Vector3 } from 'three';

export const WATCH_FRAMES = 90;       // judged frames with no pixel at all before the petals count as invisible
const MIN_RISE = 0.6;                 // the head clears the water around here; below that it may be hidden by the surface

/**
 * @param {{renderer: any, camera: any, anchor: any}} env  the main camera is the one whose draw is measured
 */
export function createPetalWatch({ renderer, camera, anchor }) {
  const gl = renderer.getContext();
  const supported = typeof gl.createQuery === 'function' && gl.ANY_SAMPLES_PASSED_CONSERVATIVE !== undefined;
  const KIND = supported ? gl.ANY_SAMPLES_PASSED_CONSERVATIVE : 0;
  const stats = { verdict: supported ? 'watching' : 'off', frames: 0, positives: 0, need: WATCH_FRAMES };     // verdict: watching | seen | blind | off
  const frustum = new Frustum(), pv = new Matrix4(), at = new Vector3();
  let mesh = null, open = null, pending = null;

  const onBefore = (r, s, cam) => {
    if (cam !== camera || open || pending) return;          // the water's mirror camera and any extra pass are not the picture
    open = gl.createQuery();
    gl.beginQuery(KIND, open);
  };
  const onAfter = () => {
    if (!open) return;
    gl.endQuery(KIND);
    pending = open;
    open = null;
  };

  function release() {
    if (open) { try { gl.endQuery(KIND); } catch (e) { /* nothing to end */ } gl.deleteQuery(open); open = null; }
    if (pending) { gl.deleteQuery(pending); pending = null; }
  }
  function detach() {
    if (mesh) { delete mesh.onBeforeRender; delete mesh.onAfterRender; mesh = null; }
    release();
  }

  /** start (or restart, after the controller swapped the mesh) watching this mesh */
  function attach(m) {
    detach();
    stats.frames = 0; stats.positives = 0;
    stats.verdict = supported ? 'watching' : 'off';
    if (!supported) return;
    mesh = m;
    m.onBeforeRender = onBefore;
    m.onAfterRender = onAfter;
  }

  const inView = () => {
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv);
    anchor.getWorldPosition(at);
    return frustum.containsPoint(at);
  };

  /** call once per frame after the picture was rendered; returns 'blind' when the petals have to be swapped */
  function update(frame) {
    if (stats.verdict !== 'watching' || !pending) return null;
    if (!gl.getQueryParameter(pending, gl.QUERY_RESULT_AVAILABLE)) return null;
    const hit = !!gl.getQueryParameter(pending, gl.QUERY_RESULT);
    gl.deleteQuery(pending);
    pending = null;
    if (hit) {
      stats.positives++;
      stats.frames++;
      stats.verdict = 'seen';
      detach();                                              // proven: no more queries
      return null;
    }
    if (frame.rise > MIN_RISE && inView()) stats.frames++;
    if (stats.frames >= WATCH_FRAMES) { stats.verdict = 'blind'; detach(); return 'blind'; }
    return null;
  }

  return { attach, detach, update, stats };
}
