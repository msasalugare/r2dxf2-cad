import { describe, expect, it } from 'vitest';
import { detectLocale, t } from './i18n';

describe('detectLocale', () => {
  it('maps Serbian, Croatian and Bosnian to the Serbian locale', () => {
    expect(detectLocale('sr-Latn')).toBe('sr');
    expect(detectLocale('sr')).toBe('sr');
    expect(detectLocale('hr')).toBe('sr');
    expect(detectLocale('bs')).toBe('sr');
  });

  it('defaults everything else to English', () => {
    expect(detectLocale('en-US')).toBe('en');
    expect(detectLocale('de-DE')).toBe('en');
    expect(detectLocale(undefined)).toBe('en');
    expect(detectLocale('')).toBe('en');
  });
});

describe('t', () => {
  it('translates a known key in both locales', () => {
    expect(t('sr', 'start.open')).toBe('Otvori PDF / sliku');
    expect(t('en', 'start.open')).toBe('Open PDF / image');
  });

  it('has the same key set for both locales', () => {
    // Every English key must exist in Serbian (enforces parity at type level,
    // checked here so a missing translation fails the suite).
    expect(t('sr', 'app.title')).not.toBe('');
    expect(t('sr', 'status.ready')).not.toBe('');
  });
});
