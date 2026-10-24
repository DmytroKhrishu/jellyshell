import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Dev server: VITE_HOST (default localhost), VITE_PORT (5174); DASH_DEV_API = the dash server to proxy (default :8098 here).
const api = process.env.DASH_DEV_API || 'http://127.0.0.1:8098';

export default defineConfig({
  plugins: [preact()],
  build: { outDir: 'dist', target: 'chrome100', sourcemap: true, assetsInlineLimit: 0 },
  server: { host: process.env.VITE_HOST || 'localhost', port: Number(process.env.VITE_PORT) || 5174, proxy: { '/api': api, '/log': api } },
});
