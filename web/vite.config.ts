import { defineConfig } from 'vitest/config';

// base path is configurable at build time (GitHub Pages uses e.g. /r2dxf/).
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    // No sourcemaps in production bundles (they nearly double dist size).
    // Opt in for debugging with VITE_SOURCEMAP=1.
    sourcemap: process.env.VITE_SOURCEMAP === '1',
    rollupOptions: {
      output: {
        advancedChunks: {
          groups: [
            // fflate is only needed for project save/open/export — keep it in
            // a separate, long-term-cacheable vendor chunk.
            { name: 'vendor-zip', test: /node_modules[\\/]fflate/ },
          ],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
