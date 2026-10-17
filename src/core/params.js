/**
 * URL parameters (used by the app and by the QA tools in tools/).
 *
 *   ?bloom=0.5      freeze bloom progress at 0..1 (rise defaults to 1 when frozen)
 *   ?rise=0.8       freeze stalk rise 0..1
 *   ?t=12.5         freeze the timeline clock at t seconds (bloom/rise derived from it)
 *   ?freeze=1       stop the clock where it is (wind/ripples/etc still animate unless ?still=1)
 *   ?still=1        fully static: time never advances (deterministic screenshots)
 *   ?quality=low|medium|high|ultra|auto
 *   ?cam=default|close|top|side|low|portrait|x,y,z,tx,ty,tz[,fov]
 *   ?hide=leaves,water,stamens,petals,pod,stem,env,post,particles   (comma list)
 *   ?dpr=1.5        force pixel ratio (disables adaptive scaling)
 *   ?debug=1        stats overlay + verbose logging
 *   ?seed=123       override the scene seed
 *   ?pace=0         no frame pacing (render on every display refresh; the resolution is still adapted) - for benchmarks
 *   ?shed=0|1|2     pin how many effects are eased (see core/shed.js); without it the governor decides and remembers
 *   ?shadow=1024    shadow map size in px (0 = shadows off)   ?refl=0.5  water reflection scale (0 = off)
 *   ?lod=0.8        geometry density multiplier              ?dof=0|1   depth of field off / on   (each overrides the tier's value)
 */
export function getParams(search = typeof location !== 'undefined' ? location.search : '') {
  const q = new URLSearchParams(search);
  const num = (k) => {
    if (!q.has(k)) return null;
    const v = parseFloat(q.get(k));
    return Number.isFinite(v) ? v : null;
  };
  const flag = (k) => q.has(k) && !['0', 'false', 'off', 'no'].includes(String(q.get(k)).toLowerCase());
  const hide = new Set((q.get('hide') || '').split(',').map((s) => s.trim()).filter(Boolean));
  return {
    raw: q,
    bloom: num('bloom'),
    rise: num('rise'),
    t: num('t'),
    freeze: flag('freeze') || flag('still') || q.has('bloom') || q.has('t'),
    still: flag('still'),
    quality: (q.get('quality') || '').trim().toLowerCase() || null,
    cam: q.get('cam') || null,
    hide,
    dpr: num('dpr'),
    debug: flag('debug'),
    seed: num('seed'),
    pace: num('pace'),
    shed: num('shed'),
    shadow: num('shadow'),
    refl: num('refl'),
    lod: num('lod'),
    dof: q.has('dof') ? flag('dof') : null,
  };
}
