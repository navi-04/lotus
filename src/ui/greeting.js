/**
 * Birthday greeting overlay (routes with kind 'birthday', e.g. /nivashini).
 *
 *   A LOTUS FOR NIVASHINI        <- whisper: fades in as the stalk rises, gone before the petals move
 *   H A P P Y   B I R T H D A Y  <- letters appear one by one as the flower opens
 *            Nivashini           <- script, written left to right with a soft golden glow
 *        ──────── ◆ ────────
 *   May this year unfold like a lotus, one petal at a time.
 *
 * Everything is a pure function of the shared frame (`frame.bloom` / `frame.rise`), so play, pause, the scrubber, replay and
 * the `?t=` stills all show exactly the right state - there are no timers or CSS animations to fall out of sync. Plain DOM text
 * on top of the canvas keeps it razor sharp at any pixel ratio and readable by screen readers (an offscreen <h1>).
 * `paintOnto()` draws the same layout onto a 2D canvas, so the "save picture" button produces a finished birthday card.
 *
 * Fonts (bundled, OFL): Cormorant Garamond for the small caps + wish, Allura for the name. See src/assets/fonts/README.txt.
 */
import { clamp01 } from '../core/timeline.js';

/** When each part appears. `rise`/`bloom` are the 0..1 timeline values (bloom 0.5 ~ 20 s, 0.9 ~ 28 s, 1.0 ~ 35 s). */
export const REVEAL = {
  whisperIn: [0.38, 0.62],      // of frame.rise
  whisperOut: [0.03, 0.11],     // of frame.bloom
  title: [0.50, 0.70],
  name: [0.62, 0.84],
  ornament: [0.80, 0.94],
  wish: [0.88, 0.99],
};

const SPAN = 5;                                    // title letters that are mid-fade at any moment
const ease = (t) => t * t * (3 - 2 * t);
const win = (x, [a, b]) => clamp01((x - a) / (b - a));

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * @param {{whisper?: string, headline: string, name: string, wish?: string}} text
 * @param {{reduced?: boolean}} [opts]   reduced = prefers-reduced-motion: plain cross-fades, no per-letter / wipe motion
 */
export async function createGreeting(text, { reduced = false } = {}) {
  const root = document.getElementById('greeting');
  if (!root) throw new Error('#greeting is missing from the page');

  const headline = String(text.headline || '').trim();
  const name = String(text.name || '').trim();
  const wishText = String(text.wish || '').trim();
  const whisperText = String(text.whisper || '').trim();

  // ---- build -------------------------------------------------------------------------------------------------------------
  root.replaceChildren();
  // Screen readers get the whole card as ordinary text; the visual lines below are aria-hidden because they are split into letters.
  root.setAttribute('aria-label', `${headline} ${name}`.trim());
  const sr = el('h1', 'g-sr', `${headline} ${name}`.trim());
  const srLines = [whisperText, wishText].filter(Boolean).map((t) => el('p', 'g-sr', t));
  const scrim = el('div', 'g-scrim');
  const stack = el('div', 'g-stack');
  scrim.setAttribute('aria-hidden', 'true');
  stack.setAttribute('aria-hidden', 'true');

  const whisper = el('p', 'g-whisper', whisperText.toUpperCase());

  const titleEl = el('div', 'g-title');
  const letters = [];
  const words = headline.toUpperCase().split(/\s+/).filter(Boolean);
  words.forEach((word, wi) => {
    const w = el('span', 'g-w');
    for (const ch of word) { const s = el('span', 'g-l', ch); letters.push(s); w.appendChild(s); }
    titleEl.appendChild(w);
    if (wi < words.length - 1) titleEl.appendChild(document.createTextNode(' '));
  });
  const titleBase = el('span', 'g-base');
  titleEl.appendChild(titleBase);

  const nameEl = el('div', 'g-name', name);
  const nameBase = el('span', 'g-base');
  nameEl.appendChild(nameBase);

  const orn = el('div', 'g-orn');

  const wishEl = el('p', 'g-wish');
  const wishWords = [];
  wishText.split(/\s+/).filter(Boolean).forEach((word, i, arr) => {
    const s = el('span', 'g-ww', word);
    wishWords.push(s);
    wishEl.appendChild(s);
    if (i < arr.length - 1) wishEl.appendChild(document.createTextNode(' '));
  });

  if (whisperText) stack.appendChild(whisper);
  stack.append(titleEl, nameEl, orn);
  if (wishText) stack.appendChild(wishEl);
  root.append(sr, ...srLines, scrim, stack);
  root.hidden = false;

  // ---- fonts: the text is laid out (and measured for the saved picture) with the real faces -------------------------------
  const fontsReady = (async () => {
    if (!document.fonts || !document.fonts.load) return;
    const timeout = new Promise((r) => setTimeout(r, 3000));
    await Promise.race([
      Promise.all([
        document.fonts.load('600 24px "Cormorant Garamond"', headline.toUpperCase() + whisperText.toUpperCase()),
        document.fonts.load('italic 500 20px "Cormorant Garamond"', wishText),
        document.fonts.load('400 64px Allura', name),
      ]).catch(() => {}),
      timeout,
    ]);
  })();

  // ---- fit: the lettering must never be wider than the screen -----------------------------------------------------------------
  // The name and the whisper are single unbreakable lines, so a long or two-word name (or a fallback font wider than Allura) would
  // run past the edges and be cut off. Their font size shrinks until they fit; a very long wish shrinks until it ends above the
  // flower. Every pass starts from the stylesheet size, and paintOnto reads the computed sizes, so the saved card follows.
  function fit() {
    const cs = getComputedStyle(stack);
    const avail = stack.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    for (const n of [nameEl, whisper, titleEl, wishEl]) n.style.fontSize = '';
    if (!(avail > 0)) return;
    for (const n of [nameEl, whisper, titleEl]) {
      const w = n.scrollWidth;
      if (w > avail + 0.5) n.style.fontSize = `${Math.max(10, parseFloat(getComputedStyle(n).fontSize) * (avail / w)).toFixed(2)}px`;
    }
    if (wishText) {
      // measured from layout (offsetTop / offsetHeight), not from rectangles: a reveal transform must not change the answer
      const limit = window.innerHeight * (window.innerWidth < window.innerHeight ? 0.42 : 0.5);
      for (let i = 0; i < 8 && wishEl.offsetTop + wishEl.offsetHeight > limit; i++) {
        const fs = parseFloat(getComputedStyle(wishEl).fontSize);
        if (fs <= 12) break;
        wishEl.style.fontSize = `${Math.max(12, fs * 0.92).toFixed(2)}px`;
      }
    }
  }
  let fitFrame = 0;
  const refit = () => { cancelAnimationFrame(fitFrame); fitFrame = requestAnimationFrame(fit); };
  window.addEventListener('resize', refit);
  window.addEventListener('orientationchange', refit);
  fit();
  fontsReady.then(fit);

  // ---- state --------------------------------------------------------------------------------------------------------------
  const P = { whisper: 0, title: 0, name: 0, ornament: 0, wish: 0, scrim: 0 };
  const applied = new Float64Array(5).fill(-1);      // values the DOM currently shows; the idle (finished) state costs nothing per frame

  function apply() {
    // whisper
    whisper.style.opacity = P.whisper < 0.002 ? '0' : String(ease(P.whisper));
    whisper.style.transform = reduced ? '' : `translate3d(0, ${((1 - ease(P.whisper)) * 0.6).toFixed(3)}em, 0)`;

    // headline: letters rise + fade one after another
    const n = letters.length;
    for (let i = 0; i < n; i++) {
      const t = reduced ? P.title : clamp01((P.title * (n - 1 + SPAN) - i) / SPAN);
      const e = ease(t);
      const s = letters[i].style;
      s.opacity = t < 0.002 ? '0' : e.toFixed(3);
      s.transform = reduced || e >= 0.999 ? '' : `translate3d(0, ${((1 - e) * 0.5).toFixed(3)}em, 0) scale(${(0.92 + 0.08 * e).toFixed(3)})`;
    }

    // name: soft-edged wipe, left to right (a single text run, so the script keeps its joins and kerning)
    const ns = nameEl.style;
    if (reduced) {
      ns.opacity = P.name < 0.002 ? '0' : String(ease(P.name));
      ns.webkitMaskImage = ns.maskImage = '';
    } else if (P.name < 0.002) {
      ns.opacity = '0';
    } else if (P.name >= 0.998) {
      ns.opacity = '1';
      ns.webkitMaskImage = ns.maskImage = '';
    } else {
      const wipe = -0.18 + ease(P.name) * 1.36;                   // % of the width: starts left of the text, ends right of it
      const m = `linear-gradient(100deg, #000 ${((wipe - 0.2) * 100).toFixed(1)}%, transparent ${(wipe * 100).toFixed(1)}%)`;
      ns.opacity = '1';
      ns.webkitMaskImage = ns.maskImage = m;
    }

    // ornament: draws outwards from the centre
    const oe = ease(P.ornament);
    orn.style.opacity = oe < 0.002 ? '0' : oe.toFixed(3);
    orn.style.transform = reduced ? '' : `scaleX(${oe.toFixed(3)})`;

    // wish
    const we = ease(P.wish);
    wishEl.style.opacity = we < 0.002 ? '0' : we.toFixed(3);
    wishEl.style.transform = reduced ? '' : `translate3d(0, ${((1 - we) * 0.7).toFixed(3)}em, 0)`;

    root.style.setProperty('--scrim', P.scrim.toFixed(3));
    root.dataset.stage = P.wish > 0.995 ? 'done' : P.name > 0.002 ? 'name' : P.title > 0.002 ? 'title' : P.whisper > 0.002 ? 'whisper' : 'none';
  }

  /** call once per frame - cheap when nothing changed */
  function update(frame) {
    const b = frame.bloom, r = frame.rise;
    P.whisper = win(r, REVEAL.whisperIn) * (1 - win(b, REVEAL.whisperOut));
    P.title = win(b, REVEAL.title);
    P.name = win(b, REVEAL.name);
    P.ornament = win(b, REVEAL.ornament);
    P.wish = win(b, REVEAL.wish);
    P.scrim = Math.min(1, ease(Math.max(P.title, P.name)) + 0.6 * P.whisper);
    let changed = false;
    for (let i = 0; i < 5; i++) {
      const v = i === 0 ? P.whisper : i === 1 ? P.title : i === 2 ? P.name : i === 3 ? P.ornament : P.wish;
      if (Math.abs(v - applied[i]) > 0.0004) { applied[i] = v; changed = true; }
    }
    if (changed) apply();
  }

  // ---- the saved picture ---------------------------------------------------------------------------------------------------
  /**
   * Measure what the picture painter needs, right now: positions, fonts and the reveal state, from the live DOM (so every
   * breakpoint is honoured). Call it synchronously when "save picture" is pressed, BEFORE the 4K render and the asynchronous PNG
   * encode: the lettering then belongs to the very frame that is rendered, and a rotation or resize while saving cannot misplace it.
   */
  function snapshot() {
    const rect = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const font = (n) => {
      const cs = getComputedStyle(n);
      return { style: cs.fontStyle, weight: cs.fontWeight, family: cs.fontFamily, size: parseFloat(cs.fontSize), tracking: parseFloat(cs.letterSpacing) || 0 };
    };
    // the wish is wrapped by the browser: its lines come from the word rectangles
    const lines = new Map();
    for (const w of wishWords) {
      const r = w.getBoundingClientRect(), key = Math.round(r.top);
      const l = lines.get(key) || { words: [], left: Infinity, right: -Infinity, bottom: r.bottom };
      l.words.push(w.textContent); l.left = Math.min(l.left, r.left); l.right = Math.max(l.right, r.right);
      lines.set(key, l);
    }
    const mid = (r) => (r.left + r.right) / 2;
    const whisperRect = rect(whisper), titleRect = rect(titleEl), nameRect = rect(nameEl);
    return {
      vw: Math.max(1, window.innerWidth),
      P: { ...P },
      whisper: whisperText ? { cx: mid(whisperRect), bottom: whisperRect.bottom, font: font(whisper) } : null,
      title: { cx: mid(titleRect), baseline: rect(titleBase).bottom, font: font(titleEl) },
      name: { rect: nameRect, cx: mid(nameRect), baseline: rect(nameBase).bottom, font: font(nameEl) },
      ornament: { rect: rect(orn) },
      wish: wishText ? { font: font(wishEl), lines: [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => ({ text: l.words.join(' '), cx: (l.left + l.right) / 2, bottom: l.bottom })) } : null,
    };
  }

  /**
   * Paint the greeting onto a 2D canvas that already holds the rendered image. `snap` comes from snapshot() (taken now when
   * omitted). Drawing is scaled by W / viewport width, so the card has the same composition at any resolution.
   */
  function paintOnto(ctx, W, H, snap = snapshot()) {
    const k = W / snap.vw;
    const S = snap.P;
    const fontOf = (f, px) => `${f.style} ${f.weight} ${px}px ${f.family}`;
    ctx.save();
    ctx.textBaseline = 'alphabetic';

    // scrim
    if (S.scrim > 0.01) {
      const g = ctx.createLinearGradient(0, 0, 0, H * 0.52);
      g.addColorStop(0, `rgba(34,22,44,${(0.46 * S.scrim).toFixed(3)})`);
      g.addColorStop(0.45, `rgba(34,22,44,${(0.27 * S.scrim).toFixed(3)})`);
      g.addColorStop(1, 'rgba(34,22,44,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H * 0.52);
    }

    const ink = (alpha) => { ctx.globalAlpha = alpha; ctx.fillStyle = '#fff6ea'; };
    const softShadow = () => { ctx.shadowColor = 'rgba(30,14,24,0.55)'; ctx.shadowBlur = 14 * k; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 1 * k; };
    const noShadow = () => { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; };
    const descentOf = (px) => { const m = ctx.measureText('Hg'); return m.fontBoundingBoxDescent != null ? m.fontBoundingBoxDescent : px * 0.24; };

    // whisper
    if (snap.whisper && S.whisper > 0.01) {
      const f = snap.whisper.font, fs = f.size * k;
      ctx.font = fontOf(f, fs);
      ink(ease(S.whisper)); softShadow();
      drawTracked(ctx, whisperText.toUpperCase(), snap.whisper.cx * k, snap.whisper.bottom * k - descentOf(fs), f.tracking * k);
      noShadow();
    }

    // headline
    if (S.title > 0.01) {
      const f = snap.title.font, fs = f.size * k;
      ctx.font = fontOf(f, fs);
      ink(ease(S.title)); softShadow();
      drawTracked(ctx, headline.toUpperCase(), snap.title.cx * k, snap.title.baseline * k, f.tracking * k);
      noShadow();
    }

    // name (gradient + glow + contact shadow, same recipe as the CSS)
    if (S.name > 0.01) {
      const f = snap.name.font, fs = f.size * k, r = snap.name.rect, cx = snap.name.cx * k, base = snap.name.baseline * k;
      ctx.font = fontOf(f, fs);
      ctx.textAlign = 'center';
      const g = ctx.createLinearGradient(0, r.top * k, 0, r.bottom * k);
      g.addColorStop(0, '#fffaf1'); g.addColorStop(0.46, '#ffe3b4'); g.addColorStop(1, '#f3b762');
      ctx.globalAlpha = ease(S.name);
      ctx.fillStyle = g;
      ctx.shadowColor = 'rgba(255,196,130,0.45)'; ctx.shadowBlur = 0.14 * fs; ctx.shadowOffsetY = 0;
      ctx.fillText(name, cx, base);
      ctx.shadowColor = 'rgba(40,18,28,0.5)'; ctx.shadowBlur = 0.06 * fs; ctx.shadowOffsetY = 0.02 * fs;
      ctx.fillText(name, cx, base);
      noShadow();
      ctx.fillText(name, cx, base);
      ctx.textAlign = 'start';
    }

    // ornament
    if (S.ornament > 0.01) {
      const r = snap.ornament.rect, oe = ease(S.ornament);
      const cx = ((r.left + r.right) / 2) * k, cy = ((r.top + r.bottom) / 2) * k, hw = ((r.width / 2) * oe) * k;
      const g = ctx.createLinearGradient(cx - hw, 0, cx + hw, 0);
      g.addColorStop(0, 'rgba(255,226,176,0)'); g.addColorStop(0.22, 'rgba(255,226,176,0.95)');
      g.addColorStop(0.78, 'rgba(255,226,176,0.95)'); g.addColorStop(1, 'rgba(255,226,176,0)');
      ctx.globalAlpha = oe;
      ctx.fillStyle = g;
      ctx.shadowColor = 'rgba(255,200,140,0.5)'; ctx.shadowBlur = 10 * k;
      ctx.fillRect(cx - hw, cy - 0.5 * k, hw * 2, Math.max(1, k));
      ctx.fillStyle = '#ffe9c4';
      const d = 3.2 * k;
      ctx.beginPath(); ctx.moveTo(cx, cy - d); ctx.lineTo(cx + d, cy); ctx.lineTo(cx, cy + d); ctx.lineTo(cx - d, cy); ctx.closePath(); ctx.fill();
      noShadow();
    }

    // wish: one DOM line at a time (the browser already balanced and wrapped it)
    if (snap.wish && S.wish > 0.01) {
      const fs = snap.wish.font.size * k;
      ctx.font = fontOf(snap.wish.font, fs);
      ink(ease(S.wish)); softShadow();
      ctx.textAlign = 'center';
      const desc = descentOf(fs);
      for (const l of snap.wish.lines) ctx.fillText(l.text, l.cx * k, l.bottom * k - desc);
      noShadow();
      ctx.textAlign = 'start';
    }
    ctx.restore();
  }

  return {
    el: root,
    ready: fontsReady,
    update,
    snapshot,
    paintOnto,
    /** latest reveal values (0..1) - for tests */
    state: () => ({ ...P, stage: root.dataset.stage || 'none' }),
    dispose() {
      window.removeEventListener('resize', refit);
      window.removeEventListener('orientationchange', refit);
      cancelAnimationFrame(fitFrame);
      root.replaceChildren(); root.hidden = true;
    },
  };
}

/** Centered text with manual letter-spacing (canvas letterSpacing is not available everywhere). */
function drawTracked(ctx, str, cx, y, tracking) {
  const chars = [...str];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + tracking * (chars.length - 1);
  let x = cx - total / 2;
  ctx.textAlign = 'start';
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== ' ') ctx.fillText(chars[i], x, y);
    x += widths[i] + tracking;
  }
}
