import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import base from '../../playwright.config';

const port = Number(process.env.NBFC_DEV_PORT ?? '3000');

// Wave 1+2 lessons: explicit testDir + DOTENV_CONFIG_QUIET to avoid noise.
process.env.DOTENV_CONFIG_QUIET = 'true';

export default defineConfig({
  ...base,
  testDir: path.resolve(__dirname),
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
