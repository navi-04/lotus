/**
 * Pages ("slash routes"). One app, several experiences - the route only decides what is layered on top of the same pond:
 *
 *   /            the plain bloom (alias of /home)
 *   /home        the plain bloom
 *   /nivashini   the same bloom + a birthday greeting that writes itself as the flower opens
 *
 * To add a page, add an entry to PAGES. The KEY is the page id and the URL: `npm run build` emits dist/<key>/index.html for it (and
 * dist-single/<key>.html), so it works on any static host with no rewrite rules. Keys are lowercase letters, digits and dashes
 * (validateRoutes checks that at build time). This file must stay free of browser globals at import time: the Vite config
 * imports it in Node to generate those pages.
 *
 * kind: 'bloom'    -> just the flower (title card + controls)
 *       'birthday' -> + greeting overlay (src/ui/greeting.js), golden sparkles (src/world/sparkles.js), lens-shifted framing
 */
const PAGES = {
  home: {
    kind: 'bloom',
    title: 'Lotus — a blooming',
    description: 'A photoreal, fully procedural blooming sacred lotus (Nelumbo nucifera) rendered in real time with three.js.',
    loaderText: 'Preparing the pond…',
  },
  nivashini: {
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

/** The table the app and the build use: every page gets its id from its key (one source of truth, so id and URL cannot drift apart). */
export const ROUTES = Object.fromEntries(Object.entries(PAGES).map(([id, page]) => [id, { ...page, id }]));

export const DEFAULT_ROUTE = 'home';

const ALIASES = { '': DEFAULT_ROUTE, index: DEFAULT_ROUTE };

/**
 * Problems with a route table (an empty list = fine). The build throws on any of them, so a typo cannot ship a dead page:
 * keys become folder names and URLs, and the title, description and loader text are baked into the generated HTML.
 */
export function validateRoutes(table = ROUTES) {
  const problems = [];
  if (!Object.prototype.hasOwnProperty.call(table, DEFAULT_ROUTE)) problems.push(`the default route "${DEFAULT_ROUTE}" is missing`);
  for (const [key, r] of Object.entries(table)) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(key)) problems.push(`route key "${key}" must be lowercase letters, digits and single dashes (it becomes a folder and a URL)`);
    if (r.id !== key) problems.push(`route "${key}": id "${r.id}" must equal its key`);
    if (r.kind !== 'bloom' && r.kind !== 'birthday') problems.push(`route "${key}": unknown kind "${r.kind}"`);
    for (const field of ['title', 'description', 'loaderText']) {
      if (typeof r[field] !== 'string' || !r[field].trim()) problems.push(`route "${key}": ${field} is required`);
    }
    if (r.kind === 'birthday' && !(r.greeting && r.greeting.headline && r.greeting.name)) problems.push(`route "${key}": a birthday page needs greeting.headline and greeting.name`);
  }
  return problems;
}

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
