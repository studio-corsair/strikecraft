import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `STRIKEBENCH_DEMO=1 vite build` produces the static hosted demo: no server, recorded data only.
export default defineConfig({
  plugins: [react()],
  define: { __DEMO__: JSON.stringify(process.env.STRIKEBENCH_DEMO === '1') },
  server: { proxy: { '/api': `http://127.0.0.1:${process.env.STRIKEBENCH_PORT ?? 4173}` } },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
});
