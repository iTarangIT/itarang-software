import { test, expect } from '@playwright/test';

/**
 * E-025 — NBFC portal sidebar navigation shell.
 *
 * Test layer: UI. Storage state: tests/.auth/nbfc_partner.json (provisioned
 * by tests/e2e/nbfc-setup.ts in the worktree-local config).
 */

test.use({ storageState: 'tests/.auth/nbfc_partner.json' });

const EXPECTED_ITEMS_IN_ORDER = [
  { id: 'portfolio', label: '📊 Portfolio Overview', href: '/nbfc/portfolio' },
  { id: 'leads', label: '🔍 Lead Intelligence', href: '/nbfc/leads' },
  { id: 'batteries', label: '🔋 Battery Monitoring', href: '/nbfc/batteries' },
  { id: 'risk', label: '⚠️ Risk Alerts', href: '/nbfc/risk' },
  { id: 'recovery', label: '🔄 Recovery & Auction', href: '/nbfc/recovery' },
  { id: 'audit', label: '📋 Audit Log', href: '/nbfc/audit' },
  { id: 'settings', label: '⚙️ Settings', href: '/nbfc/settings' },
] as const;

test.describe('E-025 — NBFC portal sidebar navigation', () => {
  test('AC1: Sidebar shows all seven NBFC nav items in BRD order', async ({ page }) => {
    await page.goto('/nbfc/portfolio');

    // Scope to the desktop sidebar (the one always visible at md+).
    const sidebar = page.locator('aside[aria-label="NBFC portal navigation"]');
    await expect(sidebar).toBeVisible();

    const items = sidebar.locator('a[data-nav-id]');
    await expect(items).toHaveCount(EXPECTED_ITEMS_IN_ORDER.length);

    for (let i = 0; i < EXPECTED_ITEMS_IN_ORDER.length; i += 1) {
      const expected = EXPECTED_ITEMS_IN_ORDER[i];
      const link = items.nth(i);
      await expect(link).toHaveAttribute('data-nav-id', expected.id);
      await expect(link).toHaveAttribute('href', expected.href);
      await expect(link).toContainText(expected.label);
    }
  });

  test('AC2: Sidebar Portfolio Overview link routes to /nbfc/portfolio', async ({ page }) => {
    // Start somewhere other than /nbfc/portfolio so the click actually navigates.
    await page.goto('/nbfc/risk');

    const sidebar = page.locator('aside[aria-label="NBFC portal navigation"]');
    await sidebar.locator('a[data-nav-id="portfolio"]').click();

    await page.waitForURL('**/nbfc/portfolio', { timeout: 15_000 });
    expect(new URL(page.url()).pathname).toBe('/nbfc/portfolio');
  });

  test('AC3: Recovery & Auction item shows active state on /nbfc/recovery routes', async ({ page }) => {
    await page.goto('/nbfc/recovery');

    const sidebar = page.locator('aside[aria-label="NBFC portal navigation"]');
    const recovery = sidebar.locator('a[data-nav-id="recovery"]');
    await expect(recovery).toHaveAttribute('data-active', 'true');
    await expect(recovery).toHaveAttribute('aria-current', 'page');

    // Negative check: a sibling (e.g. Settings) must NOT be active.
    const settings = sidebar.locator('a[data-nav-id="settings"]');
    await expect(settings).toHaveAttribute('data-active', 'false');
  });
});
