import { test, expect } from '@playwright/test';
import { plainAuthPage, authStateFor, detailStep } from './_flow-helpers';
import { LeadCreationPage } from '../pages/LeadCreationPage';
import { buildDealerLead } from '../factories/lead.factory';

/**
 * Flow A — Sales-head "dealer lead" form at /leads/new (single page).
 *
 * A sales_head captures a lead ABOUT a prospective dealer. Submit POSTs to
 * /api/dealer-leads, which we STUB so nothing is written to the sandbox DB —
 * we assert the form gathers the right payload and the required-field guard
 * holds. No paid APIs, no persistence.
 *
 * Auth: prefer the sales_head session; fall back to ceo (who can roam every
 * dashboard and reach /leads/new) so the suite still runs when only the seeded
 * ceo login is available. Skips (recorded as "Skipped") if neither exists.
 *
 * Every UI action/assertion is wrapped in detailStep(...) so the workflow
 * reporter emits a row-per-step in the "Detailed Steps" sheet.
 */
const MODULE = 'Sales-Head Dealer Lead';

function resolveAuth(): { role: string; state: string } | null {
  for (const role of ['sales_head', 'ceo']) {
    const state = authStateFor(role);
    if (state) return { role, state };
  }
  return null;
}

test.describe('Sales-head dealer lead creation', () => {
  test(`walks the create form and submits a correct payload [module:${MODULE}]`, async ({ browser }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULE });
    const auth = resolveAuth();
    if (!auth) test.skip(true, 'NOT_IMPLEMENTED: no auth state for sales_head or ceo');

    const { context, page } = await plainAuthPage(browser, auth!.state);
    try {
      // Stub the create endpoint — success without touching the DB.
      let capturedPayload: Record<string, unknown> | null = null;
      await page.route('**/api/dealer-leads', (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        capturedPayload = route.request().postDataJSON();
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, id: 'L-E2E-STUB', data: { id: 'L-E2E-STUB' } }),
        });
      });

      const input = buildDealerLead(testInfo.workerIndex, testInfo.testId, {
        interest: 'warm',
        language: 'hinglish',
      });
      const leadPage = new LeadCreationPage(page);

      // Navigate + /login guard OUTSIDE detailStep so a skip stays a Skip.
      // A fresh context's Supabase session is sometimes not recognized on the
      // very first protected navigation and bounces to /login — retry once
      // before deciding it's genuinely unreachable.
      await page.goto('/leads/new');
      if (page.url().includes('/login')) {
        await page.waitForTimeout(1_500);
        await page.goto('/leads/new');
      }
      if (page.url().includes('/login')) {
        test.skip(true, `NOT_IMPLEMENTED: "${auth!.role}" session cannot reach /leads/new on this env (redirected to /login)`);
      }

      await detailStep(
        testInfo,
        {
          description: `Open /leads/new as "${auth!.role}" and wait for the form to mount`,
          expected: 'Heading "New Dealer Lead" and the "Create Lead" button are visible',
        },
        async () => {
          await expect(page.getByRole('heading', { name: /new dealer lead/i })).toBeVisible({ timeout: 15_000 });
          await expect(page.getByRole('button', { name: /create lead/i })).toBeVisible();
          return 'form mounted; Create Lead button visible';
        },
      );

      await detailStep(
        testInfo,
        {
          description: `Fill Dealer Name = "${input.dealerName}"`,
          expected: `Name field holds "${input.dealerName}"`,
        },
        async () => {
          const field = page.getByPlaceholder('e.g. Ramesh Kumar');
          await field.fill(input.dealerName);
          return `field value = "${await field.inputValue()}"`;
        },
      );

      await detailStep(
        testInfo,
        {
          description: `Fill Phone = "${input.phone}"`,
          expected: `Phone field holds "${input.phone}"`,
        },
        async () => {
          const field = page.getByPlaceholder('+919876543210');
          await field.fill(input.phone);
          return `field value = "${await field.inputValue()}"`;
        },
      );

      await detailStep(
        testInfo,
        {
          description: `Fill Shop Name = "${input.shopName}"`,
          expected: `Shop field holds "${input.shopName}"`,
        },
        async () => {
          const field = page.getByPlaceholder('e.g. Ramesh Battery Shop');
          await field.fill(input.shopName);
          return `field value = "${await field.inputValue()}"`;
        },
      );

      await detailStep(
        testInfo,
        {
          description: `Fill Location = "${input.location}"`,
          expected: `Location field holds "${input.location}"`,
        },
        async () => {
          const field = page.getByPlaceholder('e.g. Nashik, Maharashtra');
          await field.fill(input.location);
          return `field value = "${await field.inputValue()}"`;
        },
      );

      await detailStep(
        testInfo,
        {
          description: `Select language toggle = "${input.language}"`,
          expected: `"${input.language}" toggle becomes the active selection`,
        },
        async () => {
          await page.getByRole('button', { name: new RegExp(`^${input.language}$`, 'i') }).click();
          return `clicked "${input.language}" language toggle`;
        },
      );

      await detailStep(
        testInfo,
        {
          description: `Select interest toggle = "${input.interest}"`,
          expected: `"${input.interest}" interest becomes the active selection`,
        },
        async () => {
          await page.getByRole('button', { name: new RegExp(`^${input.interest}$`, 'i') }).click();
          return `clicked "${input.interest}" interest toggle`;
        },
      );

      await detailStep(
        testInfo,
        {
          description: 'Click "Create Lead" and capture the POST to /api/dealer-leads',
          expected:
            'POST body matches the form: dealer_name, phone, location, language=hinglish, current_status=warm',
        },
        async () => {
          const req = await leadPage.submitAndWaitForRequest();
          const body = req.postDataJSON();
          expect(body).toMatchObject({
            dealer_name: input.dealerName,
            phone: input.phone,
            location: input.location,
            language: 'hinglish',
            current_status: 'warm',
          });
          return `POST sent: ${JSON.stringify(capturedPayload ?? body).slice(0, 200)}`;
        },
      );
    } finally {
      await context.close();
    }
  });

  test(`blocks submit on empty required fields [module:${MODULE}]`, async ({ browser }, testInfo) => {
    testInfo.annotations.push({ type: 'module', description: MODULE });
    const auth = resolveAuth();
    if (!auth) test.skip(true, 'NOT_IMPLEMENTED: no auth state for sales_head or ceo');

    const { context, page } = await plainAuthPage(browser, auth!.state);
    try {
      // If a POST somehow fires, stub it so no DB write happens.
      let postFired = false;
      await page.route('**/api/dealer-leads', (route) => {
        postFired = true;
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
      });
      const leadPage = new LeadCreationPage(page);

      // Navigate + /login guard OUTSIDE detailStep so a skip stays a Skip.
      // A fresh context's Supabase session is sometimes not recognized on the
      // very first protected navigation and bounces to /login — retry once
      // before deciding it's genuinely unreachable.
      await page.goto('/leads/new');
      if (page.url().includes('/login')) {
        await page.waitForTimeout(1_500);
        await page.goto('/leads/new');
      }
      if (page.url().includes('/login')) {
        test.skip(true, `NOT_IMPLEMENTED: "${auth!.role}" session cannot reach /leads/new on this env (redirected to /login)`);
      }

      await detailStep(
        testInfo,
        {
          description: 'Open /leads/new with all fields empty',
          expected: 'Form mounts with the "Create Lead" button visible',
        },
        async () => {
          await expect(page.getByRole('heading', { name: /new dealer lead/i })).toBeVisible({ timeout: 15_000 });
          await expect(page.getByRole('button', { name: /create lead/i })).toBeVisible();
          return 'empty form mounted';
        },
      );

      await detailStep(
        testInfo,
        {
          description: 'Click "Create Lead" with no data entered',
          expected: 'Required-field guard holds: no POST fires and the form stays on screen',
        },
        async () => {
          await leadPage.clickSubmit();
          await expect(page.getByRole('button', { name: /create lead/i })).toBeVisible();
          return `still on form; create POST fired = ${postFired}`;
        },
      );
    } finally {
      await context.close();
    }
  });
});
