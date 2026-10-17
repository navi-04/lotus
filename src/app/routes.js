/**
 * Pages ("slash routes"). One app, several experiences - the route only decides what is layered on top of the same pond:
 *
 *   /            the plain bloom (alias of /home)
 *   /home        the plain bloom
 *   /nivashini   the same bloom + a birthday greeting that writes itself as the flower opens
 *
 * To add a page, add an entry here. `npm run build` then emits dist/<id>/index.html for it (and dist-single/<id>.html),
 * so it works on any static host with no rewrite rules. This file must stay free of browser globals at import time:
 * the Vite config imports it in Node to generate those pages.
 *
 * kind: 'bloom'    -> just the flower (title card + controls)
 *       'birthday' -> + greeting overlay (src/ui/greeting.js), golden sparkles (src/world/sparkles.js), lens-shifted framing
 */
export const ROUTES = {
  home: {
    id: 'home',
    kind: 'bloom',
    title: 'Lotus — a blooming',
    description: 'A photoreal, fully procedural blooming sacred lotus (Nelumbo nucifera) rendered in real time with three.js.',
    loaderText: 'Preparing the pond…',
  },
  nivashini: {
    id: 'nivashini',
    kind: 'birthday',
    title: 'Happy Birthday Nivashini',
    description: 'A lotus blooms at dawn for Nivashini’s birthday.',
    loaderText: 'Preparing a lotus for Nivashini…',
    greeting: {
      whisper: 'A lotus for Nivashini',
      headline: 'Happy Birthday',
      name: 'Nivashini',
      wish: 'May this year unfold like a lotus, one petal at a time.',
    },
  },
};

export const DEFAULT_ROUTE = 'home';

const ALIASES = { '': DEFAULT_ROUTE, index: DEFAULT_ROUTE };

/**
 * Route for a URL path: the last path segment (minus ".html", and ignoring a trailing "index" so /nivashini/index.html works),
 * case-insensitive. Returns null for anything unknown (the caller falls back to the default page).
 */
export function routeFromPath(pathname = '/') {
  const segs = [];
  for (const part of String(pathname).split('/')) {
    if (!part) continue;
    let s = part;
    try { s = decodeURIComponent(part); } catch (e) { /* keep the raw segment */ }
    segs.push(s.toLowerCase().replace(/\.html?$/, ''));
  }
  if (segs[segs.length - 1] === 'index') segs.pop();
  const seg = segs[segs.length - 1] || '';
  const id = ALIASES[seg] ?? seg;
  return Object.prototype.hasOwnProperty.call(ROUTES, id) ? ROUTES[id] : null;
}

/**
 * Which page is this? Priority: ?route=<id> (also how a file:// copy can be switched) > the page's own
 * <meta name="lotus-route"> (baked into the generated pages) > the URL path > the default page.
 * `loc` / `doc` are injectable for tests.
 */
export function resolveRoute(loc = globalThis.location, doc = globalThis.document) {
  const pick = (id) => (id && Object.prototype.hasOwnProperty.call(ROUTES, String(id).toLowerCase()) ? ROUTES[String(id).toLowerCase()] : null);
  let fromQuery = null;
  try { fromQuery = pick(new URLSearchParams((loc && loc.search) || '').get('route')); } catch (e) { /* ignore */ }
  if (fromQuery) return fromQuery;
  let fromMeta = null;
  try {
    const m = doc && doc.querySelector && doc.querySelector('meta[name="lotus-route"]');
    fromMeta = pick(m && m.getAttribute('content'));
  } catch (e) { /* ignore */ }
  if (fromMeta) return fromMeta;
  return routeFromPath(loc && loc.pathname) || ROUTES[DEFAULT_ROUTE];
}
