// Minimal i18n: Serbian (Latin) + English, keyed by navigator.language.

export type Locale = 'sr' | 'en';

const sr = {
  'app.title': 'RasterFit',
  'app.tagline': 'Precizno fitovanje skice na kalibrisan raster crtež',
  'start.open': 'Otvori PDF / sliku',
  'start.sample': 'Probaj primer',
  'start.privacy': 'Sve radi lokalno u vašem pregledaču — ništa se ne otprema.',
  'start.drop': 'Pustite datoteku da biste je otvorili',
  'theme.toggle': 'Promeni temu',
  'status.ready': 'Spremno',
  'status.loading': 'Učitavanje…',
  'status.importing': 'Uvoz…',
  'status.imported': 'Uvezeno',
  'status.page': 'Strana {n}/{total}',
  'status.coords': 'x {x} · y {y}',
  'status.zoom': 'zum {z}%',
  'autosave.prompt': 'Postoji sačuvana sesija. Nastaviti?',
  'autosave.continue': 'Nastavi',
  'autosave.discard': 'Odbaci',
  'autosave.unavailable': 'Autosave nije dostupan — radiće u memoriji.',
  'error.tooLarge': 'Datoteka je prevelika (maksimum 100 MB).',
  'error.encrypted': 'Šifrovani PDF nije podržan.',
  'error.corrupt': 'Datoteka je oštećena ili je ne možemo pročitati.',
  'error.unsupported': 'Nepodržan tip datoteke (PDF / PNG / JPEG / WebP).',
  'error.failed': 'Uvoz nije uspeo.',
  'viewer.fit': 'Uklopi',
  'viewer.zoomIn': 'Uvećaj',
  'viewer.zoomOut': 'Umanji',
  'toolbar.calibrate': 'Kalibriši',
  'pages.title': 'Stranice',
  'pages.prev': 'Prethodna strana',
  'pages.next': 'Sledeća strana',
  'calibrate.title': 'Kalibracija',
  'calibrate.hint': 'Kliknite dve tačke da dodate segment',
  'calibrate.solve': 'Izračunaj',
  'calibrate.apply': 'Primeni',
  'calibrate.reset': 'Resetuj',
  'calibrate.level': 'Niveliši',
  'calibrate.close': 'Zatvori',
  'calibrate.segment': 'Segment {n}',
  'calibrate.length': 'Dužina',
  'calibrate.orientation': 'Orijentacija',
  'calibrate.free': 'Slobodno',
  'calibrate.horizontal': 'Horizontalno',
  'calibrate.vertical': 'Vertikalno',
  'calibrate.include': 'Uključi',
  'calibrate.result.rotation': 'Rotacija',
  'calibrate.result.scale': 'Razmera',
  'calibrate.result.residuals': 'Reziduali',
  'calibrate.result.none': 'Dodajte segmente pa kliknite „Izračunaj“',
  'calibrate.warning.too-few': 'Premalo segmenata',
  'calibrate.warning.high-max-residual': 'Maksimalni rezidual > 0,3 %',
  'calibrate.warning.nearly-parallel': 'Segmenti su skoro paralelni',
  'calibrate.warning.short-segment': 'Segment je prekratak',
  'calibrate.level.hint': 'Kliknite dve tačke na liniji za nivelisanje',
  'calibrate.error.invalid-length': 'Neispravna dužina',
} as const;

const en: Record<keyof typeof sr, string> = {
  'app.title': 'RasterFit',
  'app.tagline': 'Precisely fit a sketch to a calibrated raster drawing',
  'start.open': 'Open PDF / image',
  'start.sample': 'Try a sample',
  'start.privacy': 'Everything runs locally in your browser — nothing is uploaded.',
  'start.drop': 'Drop a file to open it',
  'theme.toggle': 'Toggle theme',
  'status.ready': 'Ready',
  'status.loading': 'Loading…',
  'status.importing': 'Importing…',
  'status.imported': 'Imported',
  'status.page': 'Page {n}/{total}',
  'status.coords': 'x {x} · y {y}',
  'status.zoom': 'zoom {z}%',
  'autosave.prompt': 'A saved session exists. Continue?',
  'autosave.continue': 'Continue',
  'autosave.discard': 'Discard',
  'autosave.unavailable': 'Autosave unavailable — running in memory.',
  'error.tooLarge': 'The file is too large (100 MB maximum).',
  'error.encrypted': 'Password-protected PDFs are not supported.',
  'error.corrupt': 'The file is corrupt or cannot be read.',
  'error.unsupported': 'Unsupported file type (PDF / PNG / JPEG / WebP).',
  'error.failed': 'Import failed.',
  'viewer.fit': 'Fit',
  'viewer.zoomIn': 'Zoom in',
  'viewer.zoomOut': 'Zoom out',
  'toolbar.calibrate': 'Calibrate',
  'pages.title': 'Pages',
  'pages.prev': 'Previous page',
  'pages.next': 'Next page',
  'calibrate.title': 'Calibration',
  'calibrate.hint': 'Click two points to add a segment',
  'calibrate.solve': 'Solve',
  'calibrate.apply': 'Apply',
  'calibrate.reset': 'Reset',
  'calibrate.level': 'Level',
  'calibrate.close': 'Close',
  'calibrate.segment': 'Segment {n}',
  'calibrate.length': 'Length',
  'calibrate.orientation': 'Orientation',
  'calibrate.free': 'Free',
  'calibrate.horizontal': 'Horizontal',
  'calibrate.vertical': 'Vertical',
  'calibrate.include': 'Include',
  'calibrate.result.rotation': 'Rotation',
  'calibrate.result.scale': 'Scale',
  'calibrate.result.residuals': 'Residuals',
  'calibrate.result.none': 'Add segments, then click Solve',
  'calibrate.warning.too-few': 'Too few segments',
  'calibrate.warning.high-max-residual': 'Max residual > 0.3 %',
  'calibrate.warning.nearly-parallel': 'Segments are nearly parallel',
  'calibrate.warning.short-segment': 'Segment is too short',
  'calibrate.level.hint': 'Click two points on a line to level it',
  'calibrate.error.invalid-length': 'Invalid length',
};

const messages: Record<Locale, Record<keyof typeof sr, string>> = { sr, en };

export type MessageKey = keyof typeof sr;

/** Pick the UI locale from a browser language tag; defaults to English. */
export function detectLocale(navLanguage: string | undefined): Locale {
  const l = (navLanguage ?? '').toLowerCase();
  if (l.startsWith('sr') || l.startsWith('hr') || l.startsWith('bs')) {
    return 'sr';
  }
  return 'en';
}

/** Resolve a message for a locale, with a safe English fallback. */
export function t(locale: Locale, key: MessageKey): string {
  return messages[locale][key] ?? messages.en[key] ?? key;
}

/** Resolve and interpolate `{name}` placeholders. */
export function tf(locale: Locale, key: MessageKey, vars: Record<string, string | number>): string {
  let out = t(locale, key);
  for (const [name, value] of Object.entries(vars)) {
    out = out.replaceAll(`{${name}}`, String(value));
  }
  return out;
}
