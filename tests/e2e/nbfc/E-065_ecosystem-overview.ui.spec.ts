/**
 * E-065 — Ecosystem Overview UI test (BRD §6.3.2).
 *
 * AC4: /admin/nbfc/ecosystem-overview renders the 7 metric tiles and the
 *      cross-NBFC comparison table for an admin caller.
 *
 * The test stubs the GET /api/admin/nbfc/ecosystem-overview response so the
 * page is decoupled from DB state.
 */
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';

const TEST_BYPASS_SECRET =
  process.env.NBFC_TEST_BYPASS_SECRET ?? 'e065-loop-bypass-secret';

test.describe('E-065 — Ecosystem Overview page', () => {
  test('AC4: renders 7 metric tiles and the cross-NBFC comparison table', async ({
    page,
  }) => {
    await page.setExtraHTTPHeaders({
      'x-nbfc-test-bypass': TEST_BYPASS_SECRET,
      'x-nbfc-test-user-id': randomUUID(),
      'x-nbfc-test-user-role': 'admin',
    });

    const tenantA = randomUUID();
    const tenantB = randomUUID();
    await page.route('**/api/admin/nbfc/ecosystem-overview', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          tiles: {
            connected_nbfcs: 3,
            total_portfolio_inr: 45_67_89_000,
            batteries_in_field: 12450,
            iot_connectivity_pct: 96.4,
            platform_uptime_pct: 99.7,
            alerts_24h: { critical: 2, warning: 7, info: 18 },
            avg_cds_network: 71.2,
          },
          comparison: [
            {
              nbfc_id: tenantA,
              nbfc_name: 'ABC Finance',
              active_loans: 1245,
              delinquency_pct: 4.2,
              avg_cds: 28,
              recovery_rate_pct: 71,
            },
            {
              nbfc_id: tenantB,
              nbfc_name: 'XYZ Capital',
              active_loans: 892,
              delinquency_pct: 7.8,
              avg_cds: 41,
              recovery_rate_pct: 58,
            },
          ],
        }),
      });
    });

    await page.goto('/admin/nbfc/ecosystem-overview');

    // 7 tiles by data-testid.
    await expect(page.getByTestId('tile-connected-nbfcs')).toContainText('3');
    await expect(page.getByTestId('tile-total-portfolio')).toBeVisible();
    await expect(page.getByTestId('tile-batteries-in-field')).toContainText(
      '12,450',
    );
    await expect(page.getByTestId('tile-iot-connectivity')).toContainText(
      '96.4%',
    );
    await expect(page.getByTestId('tile-platform-uptime')).toContainText(
      '99.7%',
    );
    await expect(page.getByTestId('tile-alerts-24h')).toBeVisible();
    await expect(page.getByTestId('tile-avg-cds-network')).toContainText('71.2');

    // Comparison table — both seeded rows present.
    await expect(page.getByTestId('ecosystem-comparison')).toBeVisible();
    await expect(page.getByTestId(`ecosystem-row-${tenantA}`)).toContainText(
      'ABC Finance',
    );
    await expect(page.getByTestId(`ecosystem-row-${tenantB}`)).toContainText(
      'XYZ Capital',
    );
  });
});
