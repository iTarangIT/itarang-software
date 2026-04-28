import { defineConfig, devices, type ReporterDescription } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';

// `override: false` — env vars set on the command line (e.g. by an npm script
// that exports E2E_BASE_URL=https://crm.itarang.com) win over the dotfile.
// Without this, .env.test.local silently overwrites the prod target.
dotenv.config({ path: path.resolve(__dirname, '.env.test.local'), override: false });

const baseURL = process.env.E2E_BASE_URL ?? 'https://sandbox.itarang.com';
const isProd = process.env.E2E_ALLOW_PROD === '1';

const reporters: ReporterDescription[] = process.env.CI
  ? [['github']]
  : [['list'], ['html', { open: 'never' }]];

if (process.env.EXCEL_REPORT === '1') {
  reporters.push([
    './tests/reporters/excel-reporter.ts',
    { outputDir: 'eval-reports' },
  ]);
}

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 300_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: reporters,
  globalTeardown: isProd ? './tests/e2e/global.teardown.ts' : undefined,
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Eval + CI runs want fast headless. Flip to headed debug with HEADED=1.
    headless: process.env.HEADED !== '1',
    launchOptions: process.env.HEADED === '1' ? { slowMo: 200 } : {},
  },
  projects: [
    {
      name: 'setup',
      testMatch: /global\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
      // Default run: exclude opt-in [live] and [manual] tagged tests.
      grepInvert: /\[(live|manual|prod)\]/,
    },
    {
      name: 'chromium-live',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
      grep: /\[live\]/,
    },
    {
      name: 'chromium-manual',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
      grep: /\[manual\]/,
    },
    // Production project — only registered when E2E_ALLOW_PROD=1 so a casual
    // `playwright test --project=chromium-prod` errors out with "unknown
    // project" instead of silently running against prod with stale env.
    ...(isProd
      ? [
          {
            name: 'chromium-prod',
            use: {
              ...devices['Desktop Chrome'],
              baseURL: process.env.E2E_BASE_URL ?? 'https://crm.itarang.com',
            },
            dependencies: ['setup'],
            grep: /\[prod\]/,
            retries: 0,
            fullyParallel: false,
          },
        ]
      : []),
  ],
});
