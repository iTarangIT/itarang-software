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
  // Force headless+no-slowMo for all nbfc-loop projects — the convergence
  // run dispatches the headed project from a long-running script and a
  // global HEADED=1 export would otherwise pop a Chrome window per spec.
  use: { ...base.use, baseURL: `http://localhost:${port}`, headless: true, launchOptions: {} },
  projects: [
    { name: 'setup', testMatch: /global\.setup\.ts/, use: { headless: true } },
    {
      // setup-personas writes tests/.auth/<persona>.json once. Other
      // projects do NOT declare it as a dependency — they read the
      // already-cached states via test.use({ storageState }) per
      // describe. Re-run manually with `bash seed_personas.sh` if a
      // storage state expires.
      name: 'setup-personas',
      testMatch: /nbfc-loop\.setup-personas\.ts$/,
      use: { ...devices['Desktop Chrome'], headless: true },
    },
    {
      name: 'nbfc-api',
      testMatch: /nbfc\/.*\.api\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], headless: true },
    },
    {
      name: 'nbfc-ui-public',
      testMatch: /nbfc\/E-027_freshness-badge\.ui\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], headless: true },
    },
    {
      name: 'nbfc-ui',
      testMatch: /nbfc\/.*\.ui\.spec\.ts$/,
      testIgnore: /nbfc\/E-027_freshness-badge\.ui\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        headless: true,
        // Default storageState retained for backwards compatibility; specs
        // that group ACs by persona override this per `describe` block via
        // test.use({ storageState: `tests/.auth/${persona}.json` }).
        storageState: 'tests/.auth/sales_head.json',
      },
      dependencies: ['setup'],
    },
    {
      // Stage 5h — headed visual layer. Captures screenshots per AC.
      // headless:true so 61 specs don't spawn 61 browser windows; the
      // visual evidence is in the saved PNGs, not a watched window.
      // Phase 2: NOT dispatched by converge.sh anymore; retained for
      // manual spot-checks (`npx playwright test ... E-046*.headed.spec.ts`).
      name: 'nbfc-headed',
      testMatch: /nbfc\/.*\.headed\.spec\.ts$/,
      testIgnore: /nbfc\/_journey_.*\.headed\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        headless: true,
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      // Phase 2 convergence gate — single integrated headed walk-through of
      // the NBFC BRD. Matches only `_journey_*.headed.spec.ts`. Boots from
      // converge.sh stage J via run_e2e_journey.sh.
      name: 'nbfc-journey',
      testMatch: /nbfc\/_journey_.*\.headed\.spec\.ts$/,
      timeout: 10 * 60_000, // a single test.describe.serial block can be long
      use: {
        ...devices['Desktop Chrome'],
        headless: true,
        viewport: { width: 1280, height: 800 },
        trace: 'retain-on-failure',
        video: 'retain-on-failure',
      },
      // Per-describe `test.use({ storageState: tests/.auth/<persona>.json })`
      // is set inside the spec file; the journey-recorder switches contexts.
    },
  ],
});
