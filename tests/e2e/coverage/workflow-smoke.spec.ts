import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { installAllStubs } from '../helpers/api-stubs';
import { ROUTES, DEALER_ROUTES, type Route } from './route-manifest';
import { SANDBOX_ROLES } from './roles';

/**
 * Broad workflow smoke — the "all workflows" breadth layer.
 *
 * For every module/route we load the page under a real session and assert it
 * renders WITHOUT a server error or a Next.js error boundary. This is a
 * READ-ONLY sweep: it navigates and observes, never clicks anything that would
 * POST to a paid-trigger endpoint. installAllStubs() is still applied as
 * defence-in-depth so any incidental client call to a paid host is neutralised.
 *
 * Auth state is resolved at RUN time (not collection time): the `setup` project
 * writes tests/.auth/<role>.json before this project runs, so we check for the
 * file inside each test and skip gracefully if that role was never authenticated
 * (missing creds / failed login). Skips still appear in the Excel report, so
 * breadth stays visible rather than silently vanishing.
 */

const AUTH_DIR = path.join('tests', '.auth');

function stateFileFor(role: string): string | null {
  const entry = SANDBOX_ROLES.find((r) => r.role === role);
  if (!entry) return null;
  const p = path.join(AUTH_DIR, entry.stateFile);
  return fs.existsSync(p) ? p : null;
}

/**
 * Load `route.path`, wait for it to settle, and fail only on a genuine
 * breakage: a 5xx document response, a Next.js error overlay/boundary, or an
 * uncaught page exception. A redirect to /login is treated as "not accessible"
 * and skips rather than fails.
 */
async function assertRendersCleanly(page: Page, route: Route): Promise<void> {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const response = await page.goto(route.path, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  if (/\/login(\?|$)/.test(page.url())) {
    test.skip(true, `redirected to /login for ${route.path} (not accessible to this session)`);
  }

  const status = response?.status() ?? 0;
  expect(status, `HTTP status for ${route.path}`).toBeLessThan(500);

  // Let client components hydrate/fetch, then look for an error surface.
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

  // Next.js dev error overlay (CSS union — valid).
  const overlay = page.locator('nextjs-portal, [data-nextjs-dialog]');
  await expect(overlay, `Next error overlay on ${route.path}`).toHaveCount(0);
  // Production client-exception fallback ("Application error: ...").
  const appError = page.getByText(/Application error/i);
  await expect(appError, `client-side exception on ${route.path}`).toHaveCount(0);

  expect(pageErrors, `uncaught page errors on ${route.path}`).toEqual([]);
}

function registerSweep(label: string, role: string, routes: Route[]): void {
  test.describe(`${label} workflow smoke`, () => {
    for (const route of routes) {
      test(`${route.path} renders [module:${route.module}]`, async ({ browser }, testInfo) => {
        testInfo.annotations.push({ type: 'module', description: route.module });

        // Resolve auth at run time — setup has written the state file by now.
        const statePath = stateFileFor(role);
        if (!statePath) {
          test.skip(
            true,
            `no auth state for role "${role}" — set E2E_${role.toUpperCase()}_EMAIL/PASSWORD to include it`,
          );
        }

        const context = await browser.newContext({ storageState: statePath! });
        const page = await context.newPage();
        try {
          await installAllStubs(page);
          await assertRendersCleanly(page, route);
        } finally {
          await context.close();
        }
      });
    }
  });
}

// Breadth: the CEO session reaches every dashboard/module.
registerSweep('All-modules (CEO)', 'ceo', ROUTES);

// Role-native: the dealer portal is scoped to a dealer session.
registerSweep('Dealer portal', 'dealer', DEALER_ROUTES);
