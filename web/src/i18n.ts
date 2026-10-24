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
  'pages.title': 'Stranice',
  'pages.prev': 'Prethodna strana',
  'pages.next': 'Sledeća strana',
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
  'pages.title': 'Pages',
  'pages.prev': 'Previous page',
  'pages.next': 'Next page',
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
