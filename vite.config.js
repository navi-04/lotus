import { defineConfig } from 'vite';
import { routePages } from './tools/vite-routes.mjs';

// Dev: `npm run dev` serves http://localhost:5173 (and the LAN, so a phone can open it).
//      Every path falls back to index.html, so /, /home and /nivashini all work; the page reads its route from the URL.
// Build: `npm run build` -> dist/ (static site, zero external assets). `base: './'` keeps it relocatable (any sub-path),
//      and the routePages plugin writes dist/home/index.html and dist/nivashini/index.html so each route is a real file.
export default defineConfig({
  base: './',
  plugins: [routePages({ mode: 'folders' })],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: true,
    port: 4173,
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 4000,
    sourcemap: false,
  },
});
