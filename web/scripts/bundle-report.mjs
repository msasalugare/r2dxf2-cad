// Prints a size report for the production build in dist/.
// Usage: npm run build:report
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const dist = new URL('../dist/assets', import.meta.url).pathname;

const rows = [];
for (const name of readdirSync(dist)) {
  const file = join(dist, name);
  if (!statSync(file).isFile()) continue;
  const buf = readFileSync(file);
  rows.push({
    name,
    raw: buf.length,
    gzip: gzipSync(buf).length,
    brotli: brotliCompressSync(buf).length,
  });
}
rows.sort((a, b) => b.raw - a.raw);

const kb = (n) => `${(n / 1024).toFixed(2).padStart(9)} kB`;
console.log(`${'file'.padEnd(42)} ${'raw'.padStart(12)} ${'gzip'.padStart(12)} ${'brotli'.padStart(12)}`);
for (const r of rows) {
  console.log(`${r.name.padEnd(42)} ${kb(r.raw)} ${kb(r.gzip)} ${kb(r.brotli)}`);
}
const total = rows.reduce(
  (acc, r) => ({ raw: acc.raw + r.raw, gzip: acc.gzip + r.gzip, brotli: acc.brotli + r.brotli }),
  { raw: 0, gzip: 0, brotli: 0 },
);
console.log(`${'TOTAL'.padEnd(42)} ${kb(total.raw)} ${kb(total.gzip)} ${kb(total.brotli)}`);
