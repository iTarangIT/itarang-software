import { defineConfig, devices } from '@playwright/test';
import base from '../../playwright.config';

const port = Number(process.env.NBFC_DEV_PORT ?? '3000');

export default defineConfig({
  ...base,
  testDir: '.',
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
