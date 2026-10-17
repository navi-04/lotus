/**
 * Vite plugin: one real HTML page per route, so every route works on ANY static host with no rewrite rules.
 *
 *   mode 'folders' (npm run build)         dist/index.html            the default page (home)
 *                                          dist/home/index.html       /home
 *                                          dist/nivashini/index.html  /nivashini   (asset URLs re-pointed with ../)
 *   mode 'files'   (npm run build:single)  dist-single/index.html     the default page
 *                                          dist-single/nivashini.html  double-click it; the file name selects the route
 *
 * Each generated page differs from the template only in <title>, the description / social-card meta and
 * <meta name="lotus-route">, which pins the page's identity even if the file is renamed or served from a sub-path
 * (see resolveRoute in src/app/routes.js). The route table is src/app/routes.js - add a route there and it is built here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROUTES, DEFAULT_ROUTE, validateRoutes } from '../src/app/routes.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Return `html` with the page identity of `route` written in. Throws if the template lost one of the tags (so a build never
 * silently ships the wrong title). Every replacement is a FUNCTION: a plain replacement string would expand "$&", "$1", "$'"
 * and friends, so a title such as "Win $1M" used to splice other tags into the page.
 */
export function applyRouteMeta(html, route) {
  const swap = (re, build, what) => {
    if (!re.test(html)) throw new Error(`vite-routes: ${what} not found in the built index.html`);
    html = html.replace(re, build);
  };
  const attr = (re, value, what) => swap(re, (m, open, close) => open + value + close, what);
  const title = esc(route.title);
  const desc = esc(route.description);
  swap(/<title>[\s\S]*?<\/title>/i, () => `<title>${title}</title>`, '<title>');
  attr(/(<meta\s+name="description"\s+content=")[^"]*(")/i, desc, 'meta description');
  attr(/(<meta\s+property="og:title"\s+content=")[^"]*(")/i, title, 'meta og:title');
  attr(/(<meta\s+property="og:description"\s+content=")[^"]*(")/i, desc, 'meta og:description');
  attr(/(<meta\s+name="twitter:title"\s+content=")[^"]*(")/i, title, 'meta twitter:title');
  attr(/(<meta\s+name="twitter:description"\s+content=")[^"]*(")/i, desc, 'meta twitter:description');
  attr(/(<meta\s+name="lotus-route"\s+content=")[^"]*(")/i, esc(route.id), 'meta lotus-route');
  // the loader shows this until the bundle runs, so a birthday page never flashes the generic pond text first
  swap(/(<p id="loader-text">)[^<]*(<\/p>)/, (m, open, close) => open + esc(route.loaderText) + close, '#loader-text');
  // the note for people reading index.html does not belong in every built page
  html = html.replace(/<!--\s*Page identity[\s\S]*?-->\s*/, () => '');
  return html;
}

/**
 * GitHub Pages (like Netlify and Cloudflare Pages) serves 404.html for ANY unknown URL, at that URL, so relative links break two
 * folders deep. When the site's base path is known - GitHub Actions: /<repo>/ from GITHUB_REPOSITORY, or PAGES_BASE to override -
 * the plain page is also written as 404.html with a <base> pointing back at the site root, so a mistyped link still shows the lotus
 * (the app falls back to the home page for paths it does not know) instead of an error page.
 */
export function pagesBase(env = process.env) {
  if (env.PAGES_BASE) return env.PAGES_BASE;
  const repo = String(env.GITHUB_REPOSITORY || '').split('/')[1];
  if (env.GITHUB_ACTIONS !== 'true' || !repo) return null;
  return /\.github\.io$/i.test(repo) ? '/' : `/${repo}/`;
}
export function notFoundPage(template, base) {
  return applyRouteMeta(template, ROUTES[DEFAULT_ROUTE]).replace(/<head>/i, () => `<head>\n<base href="${esc(base)}">`);
}

/** Pages live one folder deeper than the template: ./assets/x -> ../assets/x (only in src= / href= attributes of the relative base). */
export function deepenRelativeUrls(html) {
  return html.replace(/(\s(?:src|href)=")\.\/(?!\/)/g, '$1../');
}

/**
 * @param {{mode?: 'folders' | 'files'}} [opts]
 */
export function routePages({ mode = 'folders' } = {}) {
  let outDir = '';
  let isBuild = false;
  let failed = false;
  return {
    name: 'lotus-route-pages',
    configResolved(cfg) {
      outDir = path.resolve(cfg.root, cfg.build.outDir);
      isBuild = cfg.command === 'build';
      const problems = validateRoutes();
      if (problems.length) throw new Error(`vite-routes: src/app/routes.js has problems:\n  - ${problems.join('\n  - ')}`);
    },
    buildEnd(err) { if (err) failed = true; },          // a failed build must show ITS error, not a follow-up about a missing index.html
    // `npm run preview`: behave like a real static host, where /nivashini redirects to the folder page /nivashini/
    configurePreviewServer(server) {
      if (mode !== 'folders') return;
      server.middlewares.use((req, res, next) => {
        const url = String(req.url || '');
        const q = url.indexOf('?');                     // everything after the FIRST "?" belongs to the query, a second "?" included
        const pathname = q < 0 ? url : url.slice(0, q);
        const query = q < 0 ? '' : url.slice(q);
        const m = /^\/([^/.]+)$/.exec(pathname);
        const id = m && m[1].toLowerCase();
        if (id && Object.prototype.hasOwnProperty.call(ROUTES, id) && fs.existsSync(path.join(outDir, id, 'index.html'))) {
          res.statusCode = 301;
          res.setHeader('Location', `/${id}/${query}`);
          res.end();
          return;
        }
        next();
      });
    },
    closeBundle: {
      order: 'post',
      handler() {
        // only a successful production build writes pages: closeBundle also fires when the dev server shuts down (it used to
        // rewrite whatever dist/ happened to exist) and after a failed build
        if (!isBuild || failed) return;
        const indexFile = path.join(outDir, 'index.html');
        if (!fs.existsSync(indexFile)) throw new Error(`vite-routes: ${indexFile} was not emitted`);
        const template = fs.readFileSync(indexFile, 'utf8');

        // the default page: the template itself, with its own route's identity
        fs.writeFileSync(indexFile, applyRouteMeta(template, ROUTES[DEFAULT_ROUTE]));

        const written = ['index.html'];
        for (const route of Object.values(ROUTES)) {
          if (mode === 'folders') {
            const dir = path.join(outDir, route.id);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'index.html'), deepenRelativeUrls(applyRouteMeta(template, route)));
            written.push(`${route.id}/index.html`);
          } else if (route.id !== DEFAULT_ROUTE) {
            fs.writeFileSync(path.join(outDir, `${route.id}.html`), applyRouteMeta(template, route));
            written.push(`${route.id}.html`);
          }
        }
        const base = mode === 'folders' ? pagesBase() : null;
        if (base) {
          fs.writeFileSync(path.join(outDir, '404.html'), notFoundPage(template, base));
          written.push('404.html');
        }
        console.log(`\n  routes: ${written.join('  ')}`);
      },
    },
  };
}
