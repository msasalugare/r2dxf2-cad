import { describe, expect, it } from 'vitest';
import { applyTheme, toggleTheme } from './theme';

interface FakeRoot {
  dataset: { theme?: string };
}

describe('applyTheme', () => {
  it('sets the data-theme attribute', () => {
    const root: FakeRoot = { dataset: {} };
    applyTheme('dark', root as unknown as HTMLElement);
    expect(root.dataset.theme).toBe('dark');
  });
});

describe('toggleTheme', () => {
  it('flips light to dark', () => {
    const root: FakeRoot = { dataset: { theme: 'light' } };
    const next = toggleTheme(root as unknown as HTMLElement);
    expect(next).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
  });

  it('flips dark to light', () => {
    const root: FakeRoot = { dataset: { theme: 'dark' } };
    const next = toggleTheme(root as unknown as HTMLElement);
    expect(next).toBe('light');
    expect(root.dataset.theme).toBe('light');
  });
});
