/**
 * E-027 — Portfolio Data Freshness Badge UI test.
 *
 * AC3: When is_stale is true the freshness badge component renders the amber
 * text "Data may be outdated — IoT sync issue".
 *
 * Strategy: stub the freshness API with is_stale=true, navigate to the
 * worktree-local test fixture page (`/nbfc-test/freshness-badge`, gated to
 * non-production) which mounts <DataFreshnessBadge/>, then assert the badge
 * shows the BRD's exact amber copy.
 */
import { test, expect } from "@playwright/test";

test.describe("E-027 — Data Freshness Badge UI", () => {
  test("AC3: Stale freshness shows amber sync-issue badge", async ({ page }) => {
    const stale = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();

    await page.route("**/api/nbfc/portfolio/freshness", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          cds_last_computed_at: stale,
          telemetry_last_ingested_at: stale,
          is_stale: true,
        }),
      });
    });

    await page.goto("/loop-test/freshness-badge");

    const badge = page.getByTestId("data-freshness-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/Data may be outdated — IoT sync issue/);
    await expect(badge).toHaveAttribute("data-stale", "true");
    // BRD calls it "amber" — we use Tailwind's amber-100 background class.
    await expect(badge).toHaveClass(/bg-amber-100/);
  });
});
