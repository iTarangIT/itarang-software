import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import base from '../../playwright.config';

const port = Number(process.env.NBFC_DEV_PORT ?? '3000');

// Wave 1+2 lessons: explicit testDir + DOTENV_CONFIG_QUIET to avoid noise.
process.env.DOTENV_CONFIG_QUIET = 'true';

// E-027 lesson: the freshness badge UI test uses a worktree-local fixture
// page at /nbfc-test/freshness-badge that is middleware-unprotected, so it
// does NOT need the global setup/storageState. It runs under the dedicated
// `nbfc-ui-public` project with no dependencies.

// Phase 0.1 (/nbfc seed-personas): the new `setup-personas` project logs in
// as every persona declared in docs/nbfc/personas.json and writes
// tests/.auth/<persona>.json. nbfc-headed/nbfc-ui/nbfc-api now depend on it
// so RBAC-gated tests run as the right user instead of a single fallback
// admin (the prior-run failure mode that produced 254 vacuous 401 screenshots).

export default defineConfig({
  ...base,
  testDir: path.resolve(__dirname),
  use: { ...base.use, baseURL: `http://localhost:${port}` },
  projects: [
    { name: 'setup', testMatch: /global\.setup\.ts/ },
    {
      name: 'setup-personas',
      testMatch: /nbfc-loop\.setup-personas\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'nbfc-api',
      testMatch: /nbfc\/.*\.api\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup-personas'],
    },
    {
      name: 'nbfc-ui-public',
      testMatch: /nbfc\/E-027_freshness-badge\.ui\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'nbfc-ui',
      testMatch: /nbfc\/.*\.ui\.spec\.ts$/,
      testIgnore: /nbfc\/E-027_freshness-badge\.ui\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        // Default storageState retained for backwards compatibility; specs
        // that group ACs by persona override this per `describe` block via
        // test.use({ storageState: `tests/.auth/${persona}.json` }).
        storageState: 'tests/.auth/sales_head.json',
      },
      dependencies: ['setup', 'setup-personas'],
    },
    {
      // Stage 5h — headed visual layer. Captures screenshots per AC.
      // headless:true so 61 specs don't spawn 61 browser windows; the
      // visual evidence is in the saved PNGs, not a watched window.
      name: 'nbfc-headed',
      testMatch: /nbfc\/.*\.headed\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        headless: true,
        viewport: { width: 1280, height: 800 },
      },
      dependencies: ['setup-personas'],
    },
  ],
});
