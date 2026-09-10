import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: 'chrome' }],
});