// Theme management: CAD-dark default with a persisted manual override.

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'rasterfit-cad.theme';

/** Resolve the initial theme, applying it to `documentElement`. */
export function initTheme(root: HTMLElement = document.documentElement): Theme {
  const theme = resolveTheme();
  applyTheme(theme, root);
  return theme;
}

export function resolveTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // localStorage unavailable (private mode / tests): fall through.
  }
  return 'dark';
}

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Persistence is best-effort.
  }
}

export function toggleTheme(root: HTMLElement = document.documentElement): Theme {
  const next: Theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next, root);
  return next;
}
