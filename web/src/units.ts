// Length parsing with units, used by the calibration panel ("125", "12.5 cm",
// "4.921 in"). Everything is stored internally in millimetres.

const UNIT_TO_MM: Record<string, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  inch: 25.4,
};

const LENGTH_RE = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z]*)\s*$/;

/** Parse a length string into millimetres, or null when invalid. */
export function parseLength(text: string): number | null {
  const m = LENGTH_RE.exec(text);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = m[2].toLowerCase();
  if (unit === '') return value;
  const factor = UNIT_TO_MM[unit];
  if (factor === undefined) return null;
  return value * factor;
}

/** Format a length in millimetres with a sensible number of decimals. */
export function formatMm(mm: number): string {
  if (!Number.isFinite(mm)) return '—';
  const decimals = Math.abs(mm) < 10 ? 3 : Math.abs(mm) < 100 ? 2 : 1;
  return `${mm.toFixed(decimals)} mm`;
}

/** Format an angle in radians as degrees. */
export function formatDegrees(radians: number): string {
  const deg = (radians * 180) / Math.PI;
  return `${deg.toFixed(3)}°`;
}
