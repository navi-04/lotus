import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { routePages } from './tools/vite-routes.mjs';

// `npm run build:single` -> dist-single/index.html : ONE self-contained file that opens by double-click (file://) -
// everything (three.js, shaders, the birthday fonts) is inlined. The plugin also writes dist-single/<route>.html
// (e.g. nivashini.html): the same file with that route's title - the file name selects the page.
export default defineConfig({
  plugins: [viteSingleFile(), routePages({ mode: 'files' })],
  build: {
    target: 'es2020',
    outDir: 'dist-single',
    chunkSizeWarningLimit: 8000,
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    sourcemap: false,
  },
});
