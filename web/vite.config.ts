import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Dev server: VITE_HOST (default localhost; 0.0.0.0 to test from a TV/console), VITE_PORT (5173).
// JELLYSHELL_DEV_API (e.g. http://127.0.0.1:8097) proxies the page-server routes so api/config, Requests etc. work in dev.
const api = process.env.JELLYSHELL_DEV_API;
const proxy = api ? Object.fromEntries(['/api', '/log'].map((p) => [p, api])) : undefined;

export default defineConfig({
  plugins: [preact()],
  base: './', // relative assets: served at / (LAN, Xbox) and under a sub-path (/jellyshell/ behind a reverse proxy / tunnel)
  build: {
    outDir: 'dist', target: 'chrome100', sourcemap: true, assetsInlineLimit: 0,
    // Second page: the phone remote (remote.html, served at /remote). Its own small bundle, no TV app code.
    rollupOptions: { input: { main: 'index.html', remote: 'remote.html' } },
  },
  server: { host: process.env.VITE_HOST || 'localhost', port: Number(process.env.VITE_PORT) || 5173, proxy },
});
