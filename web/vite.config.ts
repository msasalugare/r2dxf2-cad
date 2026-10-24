import { defineConfig, type Plugin } from 'vitest/config';
import { cpSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// base path is configurable at build time (GitHub Pages uses e.g. /r2dxf/).
const base = process.env.VITE_BASE ?? '/';

// PDF.js runtime assets that must be served same-origin (no CDN, no external
// runtime fetch): CMaps, standard fonts, wasm decoders, and ICC profiles.
const PDFJS_SUBDIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'] as const;

function pdfjsRoot(): string {
  const require = createRequire(import.meta.url);
  return path.dirname(require.resolve('pdfjs-dist/package.json'));
}

function mimeFor(filePath: string): string {
  switch (path.extname(filePath)) {
    case '.wasm':
      return 'application/wasm';
    case '.ttf':
      return 'font/ttf';
    default:
      return 'application/octet-stream';
  }
}

function pdfjsAssets(): Plugin {
  const root = pdfjsRoot();
  const allowed = new Set<string>(PDFJS_SUBDIRS);

  return {
    name: 'rasterfit:pdfjs-assets',

    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const segments = decodeURIComponent((req.url ?? '').split('?')[0])
          .replace(/^\/pdfjs\//, '')
          .split('/');
        const subdir = segments[0];
        if (!subdir || !allowed.has(subdir)) {
          next();
          return;
        }
        const rel = segments.slice(1);
        if (rel.length === 0 || rel.some((p) => p === '..' || p === '.' || p === '')) {
          next();
          return;
        }

        const filePath = path.resolve(root, subdir, ...rel);
        if (!filePath.startsWith(path.resolve(root, subdir) + path.sep)) {
          next();
          return;
        }

        let body: Buffer;
        try {
          body = readFileSync(filePath);
        } catch {
          next();
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', mimeFor(filePath));
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.end(body);
      });
    },

    closeBundle() {
      const outDir = path.resolve('dist', 'pdfjs');
      for (const subdir of PDFJS_SUBDIRS) {
        cpSync(path.join(root, subdir), path.join(outDir, subdir), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  plugins: [pdfjsAssets()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
