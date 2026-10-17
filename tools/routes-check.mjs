#!/usr/bin/env node
/**
 * Unit checks for the route table, the resolver and the page generator (no browser, no build): node tools/routes-check.mjs
 * Covers what static hosting depends on: odd URLs, hostile titles, the 404 page base, and a table that cannot ship a dead page.
 */
import fs from 'node:fs';
import { ROUTES, DEFAULT_ROUTE, routeFromPath, resolveRoute, validateRoutes } from '../src/app/routes.js';
import { applyRouteMeta, deepenRelativeUrls, pagesBase, notFoundPage } from './vite-routes.mjs';

let failed = 0, total = 0;
const check = (name, ok, info = '') => { total++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); };
const idOf = (r) => (r ? r.id : null);

// ---- the resolver: URLs --------------------------------------------------------------------------------------------------
const PATHS = [
  ['/', 'home'], ['', 'home'], ['/index.html', 'home'], ['/home', 'home'], ['/home/', 'home'],
  ['/nivashini', 'nivashini'], ['/nivashini/', 'nivashini'], ['/Nivashini/', 'nivashini'], ['/NIVASHINI/index.html', 'nivashini'],
  ['/nivashini.html', 'nivashini'], ['/%6Eivashini', 'nivashini'], ['//nivashini', 'nivashini'], ['/a/b/nivashini/', 'nivashini'],
  ['/lotus/nivashini/', 'nivashini'], ['/lotus/home/', 'home'],
  ['/lotus/', null], ['/unknown', null], ['/nivashini/extra', null],
  ['/__proto__', null], ['/constructor', null], ['/toString', null], ['/hasOwnProperty', null], ['/%E0%A4%A', null],
];
for (const [p, want] of PATHS) check(`path ${JSON.stringify(p)} -> ${want}`, idOf(routeFromPath(p)) === want, `got ${idOf(routeFromPath(p))}`);

// ---- the resolver: priority (query > page meta > path > default) ------------------------------------------------------------
const doc = (content) => ({ querySelector: () => (content == null ? null : { getAttribute: () => content }) });
const loc = (pathname, search = '') => ({ pathname, search });
check('?route= beats the path', idOf(resolveRoute(loc('/home', '?route=nivashini'), doc(null))) === 'nivashini');
check('?route= is case-insensitive', idOf(resolveRoute(loc('/', '?route=NIVASHINI'), doc(null))) === 'nivashini');
check('?route=bogus falls through to the path', idOf(resolveRoute(loc('/nivashini', '?route=bogus'), doc(null))) === 'nivashini');
check('the page meta beats the path (a renamed file keeps its page)', idOf(resolveRoute(loc('/birthday.html'), doc('nivashini'))) === 'nivashini');
check('meta "auto" defers to the path', idOf(resolveRoute(loc('/nivashini/'), doc('auto'))) === 'nivashini');
check('a bogus meta defers to the path', idOf(resolveRoute(loc('/nivashini/'), doc('nope'))) === 'nivashini');
check('?route= beats the meta', idOf(resolveRoute(loc('/', '?route=home'), doc('nivashini'))) === 'home');
check('unknown everything -> the default page', idOf(resolveRoute(loc('/zzz'), doc(null))) === DEFAULT_ROUTE);
check('no location and no document -> the default page', idOf(resolveRoute(undefined, undefined)) === DEFAULT_ROUTE);
check('a throwing document.querySelector is survived', idOf(resolveRoute(loc('/nivashini'), { querySelector() { throw new Error('boom'); } })) === 'nivashini');
check('prototype-ish ?route= values never resolve', idOf(resolveRoute(loc('/'), doc(null)) ) === 'home' && idOf(resolveRoute(loc('/', '?route=__proto__'), doc(null))) === 'home' && idOf(resolveRoute(loc('/', '?route=constructor'), doc(null))) === 'home');

// ---- the table -------------------------------------------------------------------------------------------------------------
check('the shipped route table is valid', validateRoutes().length === 0, validateRoutes().join('; '));
check('every route id equals its key', Object.entries(ROUTES).every(([k, r]) => r.id === k));
const good = { id: 'x', kind: 'bloom', title: 't', description: 'd', loaderText: 'l' };
const table = (extra) => ({ home: { ...good, id: 'home' }, ...extra });
check('rejects an uppercase key', validateRoutes(table({ Maya: { ...good, id: 'Maya' } })).length > 0);
check('rejects a key with a slash', validateRoutes(table({ 'a/b': { ...good, id: 'a/b' } })).length > 0);
check('rejects a key with a dot', validateRoutes(table({ 'a.b': { ...good, id: 'a.b' } })).length > 0);
check('rejects an id that differs from its key', validateRoutes(table({ maya: { ...good, id: 'maya2' } })).length > 0);
check('rejects a missing title', validateRoutes(table({ maya: { ...good, id: 'maya', title: '' } })).length > 0);
check('rejects an unknown kind', validateRoutes(table({ maya: { ...good, id: 'maya', kind: 'party' } })).length > 0);
check('rejects a birthday page without a name', validateRoutes(table({ maya: { ...good, id: 'maya', kind: 'birthday', greeting: { headline: 'h' } } })).length > 0);
check('rejects a table without the default route', validateRoutes({ maya: { ...good, id: 'maya' } }).length > 0);
check('accepts a well-formed extra page', validateRoutes(table({ 'maya-2': { ...good, id: 'maya-2', kind: 'birthday', greeting: { headline: 'Happy Birthday', name: 'Maya' } } })).length === 0);

// ---- the page generator ------------------------------------------------------------------------------------------------------
const template = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const HOSTILE = ['Win $1M', 'Only $& left', "rest $' and $`", 'cash $$ now', 'quote " < > & ’', 'emoji 🪷 ok'];
for (const t of HOSTILE) {
  const out = applyRouteMeta(template, { id: 'x', title: t, description: `${t} d`, loaderText: t });
  const intact = out.includes(`<title>${esc(t)}</title>`) && out.includes(`<p id="loader-text">${esc(t)}</p>`) && out.includes(`content="${esc(t)}"`);
  check(`hostile text stays literal: ${JSON.stringify(t)}`, intact && out.length < template.length + 500, `page ${out.length} B, template ${template.length} B`);
}
for (const [id, r] of Object.entries(ROUTES)) {
  const out = applyRouteMeta(template, r);
  check(`page identity for ${id}: title, description, og, twitter, route meta, loader text`,
    out.includes(`<title>${esc(r.title)}</title>`) && out.includes(`<meta name="lotus-route" content="${id}" />`) &&
    out.includes(`<meta property="og:title" content="${esc(r.title)}" />`) && out.includes(`<meta name="twitter:description" content="${esc(r.description)}" />`) &&
    out.includes(`<p id="loader-text">${esc(r.loaderText)}</p>`));
}
check('the developer note about "auto" is not shipped in built pages', template.includes('Page identity') && !applyRouteMeta(template, ROUTES.home).includes('Page identity'));
for (const [what, strip] of [['<title>', /<title>[\s\S]*?<\/title>/i], ['the route meta', /<meta\s+name="lotus-route"[^>]*>/i], ['the loader text', /<p id="loader-text">[^<]*<\/p>/]]) {
  let threw = false;
  try { applyRouteMeta(template.replace(strip, ''), ROUTES.home); } catch (e) { threw = /not found/.test(String(e.message)); }
  check(`a template that lost ${what} fails the build loudly`, threw);
}
check('deepenRelativeUrls turns ./ into ../ in src and href only', deepenRelativeUrls('<script src="./assets/a.js"></script><link href="./assets/a.css"><a href="//cdn/x"><link href="data:x"><img src="/abs.png">')
  === '<script src="../assets/a.js"></script><link href="../assets/a.css"><a href="//cdn/x"><link href="data:x"><img src="/abs.png">');

// ---- the 404 page for GitHub Pages ----------------------------------------------------------------------------------------------
check('pagesBase: nothing outside CI', pagesBase({}) === null && pagesBase({ GITHUB_REPOSITORY: 'a/b' }) === null);
check('pagesBase: a project page lives under /<repo>/', pagesBase({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'navi-04/lotus' }) === '/lotus/');
check('pagesBase: a user page lives at the root', pagesBase({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'navi-04/navi-04.github.io' }) === '/');
check('pagesBase: PAGES_BASE overrides', pagesBase({ PAGES_BASE: '/x/' }) === '/x/');
const nf = notFoundPage(template, '/lotus/');
check('404 page: base tag first in <head>, plain page identity', /<head>\s*<base href="\/lotus\/">/.test(nf) && nf.includes('<meta name="lotus-route" content="home" />') && nf.includes(`<title>${esc(ROUTES.home.title)}</title>`));
check('404 page: the base is escaped', notFoundPage(template, '/a"b/').includes('<base href="/a&quot;b/">'));

console.log(JSON.stringify({ total, failed }));
process.exit(failed ? 1 : 0);
