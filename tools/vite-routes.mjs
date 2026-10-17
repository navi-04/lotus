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
import { ROUTES, DEFAULT_ROUTE } from '../src/app/routes.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Return `html` with the page identity of `route` written in. Throws if the template lost one of the tags (so a build never silently ships the wrong title). */
export function applyRouteMeta(html, route) {
  const swap = (re, to, what) => {
    if (!re.test(html)) throw new Error(`vite-routes: <${what}> not found in the built index.html`);
    html = html.replace(re, to);
  };
  const title = esc(route.title);
  const desc = esc(route.description);
  swap(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`, 'title');
  swap(/(<meta\s+name="description"\s+content=")[^"]*(")/i, `$1${desc}$2`, 'meta description');
  swap(/(<meta\s+property="og:title"\s+content=")[^"]*(")/i, `$1${title}$2`, 'meta og:title');
  swap(/(<meta\s+property="og:description"\s+content=")[^"]*(")/i, `$1${desc}$2`, 'meta og:description');
  swap(/(<meta\s+name="twitter:title"\s+content=")[^"]*(")/i, `$1${title}$2`, 'meta twitter:title');
  swap(/(<meta\s+name="twitter:description"\s+content=")[^"]*(")/i, `$1${desc}$2`, 'meta twitter:description');
  swap(/(<meta\s+name="lotus-route"\s+content=")[^"]*(")/i, `$1${esc(route.id)}$2`, 'meta lotus-route');
  return html;
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
  return {
    name: 'lotus-route-pages',
    configResolved(cfg) { outDir = path.resolve(cfg.root, cfg.build.outDir); },
    // `npm run preview`: behave like a real static host, where /nivashini redirects to the folder page /nivashini/
    configurePreviewServer(server) {
      if (mode !== 'folders') return;
      server.middlewares.use((req, res, next) => {
        const [pathname, query] = String(req.url || '').split('?');
        const m = /^\/([^/.]+)$/.exec(pathname);
        const id = m && m[1].toLowerCase();
        if (id && Object.prototype.hasOwnProperty.call(ROUTES, id) && fs.existsSync(path.join(outDir, id, 'index.html'))) {
          res.statusCode = 301;
          res.setHeader('Location', `/${id}/${query ? `?${query}` : ''}`);
          res.end();
          return;
        }
        next();
      });
    },
    closeBundle: {
      order: 'post',
      handler() {
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
        console.log(`\n  routes: ${written.join('  ')}`);
      },
    },
  };
}
