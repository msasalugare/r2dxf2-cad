import { defineConfig } from 'vitest/config';

// base path is configurable at build time (GitHub Pages uses e.g. /r2dxf/).
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
