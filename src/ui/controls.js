/**
 * UI - frosted-glass control bar (play/pause, replay, bloom scrubber, quality, 4K capture, fullscreen), title card, toast,
 * keyboard shortcuts. Auto-hides after a few idle seconds; every control is a >= 42 px target; safe-area aware (CSS).
 */
const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="f" d="M8 5.2v13.6a.9.9 0 0 0 1.4.75l10.2-6.8a.9.9 0 0 0 0-1.5L9.4 4.45A.9.9 0 0 0 8 5.2Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect class="f" x="6.2" y="4.6" width="3.8" height="14.8" rx="1.2"/><rect class="f" x="14" y="4.6" width="3.8" height="14.8" rx="1.2"/></svg>',
  replay: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5"/><path d="M4.2 3.8v4.1h4.1"/></svg>',
  quality: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/></svg>',
  capture: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 8.2a1.7 1.7 0 0 1 1.7-1.7h1.5l1.2-1.8h6.2l1.2 1.8h1.5a1.7 1.7 0 0 1 1.7 1.7v8.6a1.7 1.7 0 0 1-1.7 1.7H6.2a1.7 1.7 0 0 1-1.7-1.7Z"/><circle cx="12" cy="12.4" r="3.3"/></svg>',
  full: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15"/></svg>',
  fullExit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4.5V9H4.5M19.5 9H15V4.5M15 19.5V15h4.5M4.5 15H9v4.5"/></svg>',
};

/**
 * @param {object} app  { getProgress():0..1, isPlaying():bool, setPlaying(b), replay(), seek(frac), seekEnd(), capture():Promise,
 *                        qualityName:string, setQuality(name), toggleFullscreen(), canFullscreen:bool }
 */
export function createUI(app) {
  const $ = (id) => document.getElementById(id);
  const bar = $('bar'), btnPlay = $('btn-play'), btnReplay = $('btn-replay'), btnQ = $('btn-quality'), btnCap = $('btn-capture'), btnFull = $('btn-full');
  const scrub = $('scrub'), menu = $('menu'), toastEl = $('toast'), titleEl = $('title');
  btnReplay.innerHTML = ICONS.replay;
  btnQ.innerHTML = ICONS.quality;
  btnCap.innerHTML = ICONS.capture;
  btnFull.innerHTML = ICONS.full;
  if (!app.canFullscreen) btnFull.style.display = 'none';

  let hideTimer = 0;
  let dragging = false;
  const showBar = () => {
    bar.classList.remove('hidden');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!dragging && menu.hidden) bar.classList.add('hidden'); }, 4200);
  };
  for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, showBar, { passive: true });
  showBar();

  function paintPlay() {
    const playing = app.isPlaying();
    btnPlay.innerHTML = playing ? ICONS.pause : ICONS.play;
    btnPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
  paintPlay();

  btnPlay.addEventListener('click', () => { app.setPlaying(!app.isPlaying()); paintPlay(); });
  btnReplay.addEventListener('click', () => { app.replay(); paintPlay(); });

  // scrubber: dragging pins the clock; releasing resumes playback
  let wasPlaying = true;
  const paintScrub = (v) => scrub.style.setProperty('--p', `${(v / 10).toFixed(1)}%`);
  scrub.addEventListener('pointerdown', () => { dragging = true; wasPlaying = app.isPlaying(); app.setPlaying(false); paintPlay(); });
  scrub.addEventListener('input', () => { paintScrub(+scrub.value); app.seek(+scrub.value / 1000); });
  const endDrag = () => { if (!dragging) return; dragging = false; app.setPlaying(wasPlaying); paintPlay(); showBar(); };
  scrub.addEventListener('pointerup', endDrag);
  scrub.addEventListener('pointercancel', endDrag);
  scrub.addEventListener('change', endDrag);

  // quality menu
  const paintMenu = () => {
    for (const b of menu.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.q === app.qualityName));
  };
  paintMenu();
  btnQ.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btnQ.setAttribute('aria-expanded', String(!menu.hidden));
    paintMenu();
  });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-q]');
    if (!b) return;
    menu.hidden = true;
    btnQ.setAttribute('aria-expanded', 'false');
    app.setQuality(b.dataset.q);
  });
  window.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== btnQ) { menu.hidden = true; btnQ.setAttribute('aria-expanded', 'false'); } });

  let capBusy = false;
  async function doCapture() {
    if (capBusy) return;
    capBusy = true;
    btnCap.style.opacity = '0.5';
    try { await app.capture(); } catch (err) { toast('Could not save the picture on this device'); }
    capBusy = false;
    btnCap.style.opacity = '';
  }
  btnCap.addEventListener('click', doCapture);
  btnFull.addEventListener('click', () => app.toggleFullscreen());
  document.addEventListener('fullscreenchange', () => { btnFull.innerHTML = document.fullscreenElement ? ICONS.fullExit : ICONS.full; });

  window.addEventListener('keydown', (e) => {
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.key !== ' ') return;
    switch (e.key.toLowerCase()) {
      case ' ': e.preventDefault(); app.setPlaying(!app.isPlaying()); paintPlay(); break;
      case 'r': app.replay(); paintPlay(); break;
      case 'f': app.toggleFullscreen(); break;
      case 'c': doCapture(); break;
      case 'q': btnQ.click(); break;
      case 'escape': menu.hidden = true; break;
      default: break;
    }
  });

  let toastTimer = 0;
  function toast(msg, ms = 3200) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  function showTitle() {
    titleEl.classList.add('show');
    setTimeout(() => titleEl.classList.remove('show'), 7500);
  }

  return {
    toast,
    showTitle,
    /** call every frame */
    update() {
      if (!dragging) {
        const v = Math.round(app.getProgress() * 1000);
        if (+scrub.value !== v) { scrub.value = String(v); paintScrub(v); }
      }
    },
    paintPlay,
  };
}
