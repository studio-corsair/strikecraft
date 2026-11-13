import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `STRIKEBENCH_DEMO=1 vite build` produces the static hosted demo: no server, simulated data only.
const api = `http://127.0.0.1:${process.env.STRIKEBENCH_PORT ?? 4173}`;

export default defineConfig({
  plugins: [react()],
  define: { __DEMO__: JSON.stringify(process.env.STRIKEBENCH_DEMO === '1') },
  server: {
    proxy: {
      '/api': {
        target: api,
        changeOrigin: true,
        // The server only answers requests from its own origin; in development the page is served
        // by Vite on another port, so present the request as same-origin.
        configure: (proxy) => proxy.on('proxyReq', (req) => req.setHeader('origin', api)),
      },
    },
  },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
});
