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
