import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import base from '../../playwright.config';

const port = Number(process.env.NBFC_DEV_PORT ?? '3000');

// Resolve testDir relative to repo root (this config sits at tests/e2e/, so
// ../../ is the repo). Without this, base.testDir='./tests/e2e' compounds
// when re-resolved against this config's location and Playwright looks at
// tests/e2e/tests/e2e.
const testDir = path.resolve(__dirname, '..', '..', 'tests', 'e2e');

export default defineConfig({
  ...base,
  testDir,
  use: { ...base.use, baseURL: `http://localhost:${port}` },
  projects: [
    { name: 'setup', testMatch: /global\.setup\.ts/ },
    {
      name: 'nbfc-api',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'nbfc-ui',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'tests/.auth/sales_head.json',
      },
      dependencies: ['setup'],
    },
  ],
});
