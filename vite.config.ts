import { defineConfig } from 'vite';

const backend = `http://127.0.0.1:${process.env.SF_PORT ?? 4477}`;

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': backend,
      '/ws': { target: backend, ws: true },
    },
  },
});
