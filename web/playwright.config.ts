import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  expect: {
    // Server-side import (upload → decode → ridge detect → fetch → pyramid)
    // can take longer than the default 5 s on a cold container.
    timeout: 20_000,
  },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
  },
});
