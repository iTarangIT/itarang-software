// End-to-end test for the "Aadhaar KYC" button on the dealer lead-creation
// page. Exercises the real Decentro DigiLocker SSO against whatever Decentro
// environment sandbox.itarang.com is wired to.
//
// This test is SEMI-AUTOMATED: the DigiLocker popup asks for an Aadhaar OTP
// sent to the real phone registered with UIDAI. Playwright can't read that
// SMS, so the tester completes the OTP entry + consent manually in the popup
// window while this test waits for the popup to close. Per-test timeout is
// 5 minutes (matches playwright.config.ts) — more than enough.
//
// Run (headed mode is forced by config):
//   npx playwright test tests/e2e/dealer-aadhaar-digilocker.spec.ts
//
// Pre-requisites:
//   - tests/.auth/dealer.json exists (log in once as your sandbox dealer
//     account and save storageState — see README / global.setup.ts patterns)
//   - .env.test.local has DATABASE_URL + SUPABASE_SERVICE_ROLE_KEY so we can
//     assert the kyc_verifications row was written
//   - Phone 7838597709 is the UIDAI-registered mobile for the Aadhaar you
//     intend to authorise

import type { Page, Request as PwRequest } from '@playwright/test';
import { eq } from 'drizzle-orm';

import { test, expect } from './fixtures';
import { closeDealerCredsClients } from './helpers/dealer-creds';

// Inlined here (not exported from dealer-creds) because the test wants direct
// DB access for a read-only assertion and we don't need to mutate anything.
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/lib/db/schema';

const TEST_PHONE = '7838597709';
const OTP_WAIT_MS = 5 * 60 * 1000; // user has 5 min to complete DigiLocker

// Default to dealer auth state. Override with DEALER_STORAGE_STATE env if the
// tester wants to use a different saved session.
const storageState =
    process.env.DEALER_STORAGE_STATE ?? 'tests/.auth/dealer.json';

test.use({ storageState });

// The real flow takes at least a minute of human input; give the whole test
// the full config-level budget (5 min) and don't reduce it.
test.describe.configure({ mode: 'serial' });

test.describe('Dealer lead creation — Aadhaar KYC via DigiLocker', () => {
    test.afterAll(async () => {
        await closeDealerCredsClients().catch(() => {});
    });

    test('opens DigiLocker popup, receives eAadhaar, prefills form, records verification', async ({
        page,
    }) => {
        test.setTimeout(OTP_WAIT_MS + 60_000);

        // ── 1. Land on the new-lead page and wait for the draft leadId ──
        await page.goto('/dealer-portal/leads/new');
        await expect(page.getByRole('heading', { name: /create new lead/i }))
            .toBeVisible({ timeout: 30_000 });

        // The "Aadhaar KYC" button is disabled while leadId is null. Wait
        // for the draft init request to finish so the button activates.
        await expect(
            page.getByRole('button', { name: /aadhaar kyc/i }),
        ).toBeEnabled({ timeout: 30_000 });

        // ── 2. Fill the phone field so the draft has the expected mobile ──
        // The "Personal Information" section is the first SectionCard on the
        // page, so `.first()` reliably scopes past Vehicle Details (which
        // reuses the same placeholder for owner phone).
        const personalSection = page.locator('section, div.bg-white').filter({
            has: page.getByRole('heading', { name: /personal information/i }),
        }).first();
        const phoneInput = personalSection.getByPlaceholder('9876543210');
        await phoneInput.fill(TEST_PHONE);

        // ── 3. Set up network + popup listeners BEFORE clicking ──
        const initiatePromise = page.waitForRequest(
            (req: PwRequest) =>
                req.url().includes('/api/leads/digilocker/initiate') &&
                req.method() === 'POST',
        );
        const popupPromise: Promise<Page> = page.waitForEvent('popup', {
            timeout: 30_000,
        });

        // ── 4. Click the Aadhaar KYC button ──
        await page.getByRole('button', { name: /aadhaar kyc/i }).click();

        const initiateReq = await initiatePromise;
        const initiateRes = await initiateReq.response();
        expect(initiateRes?.status(), 'initiate should return 200').toBe(200);
        const initiateJson = await initiateRes!.json();
        expect(initiateJson.success).toBe(true);
        const transactionId: string = initiateJson.data.transactionId;
        const authorizationUrl: string = initiateJson.data.authorizationUrl;
        expect(transactionId).toMatch(/^DIGI-/);
        expect(authorizationUrl).toMatch(/decentro/i);

        console.log('\n[digilocker-test] Transaction:', transactionId);
        console.log('[digilocker-test] Authorization URL:', authorizationUrl);

        // ── 5. Popup opened — guide the human ──
        const popup: Page = await popupPromise;
        console.log(
            '\n[digilocker-test] ===> Complete DigiLocker auth in the popup:',
        );
        console.log(
            '[digilocker-test]      1. Enter Aadhaar number',
        );
        console.log(
            `[digilocker-test]      2. Enter OTP sent to ${TEST_PHONE}`,
        );
        console.log(
            '[digilocker-test]      3. Consent to iTarang\n',
        );

        // ── 6. Wait for the popup to close (our callback runs window.close()) ─
        // If the user cancels, `popup.close` still fires — subsequent
        // assertions on the form will fail loudly.
        await popup.waitForEvent('close', { timeout: OTP_WAIT_MS });
        console.log('[digilocker-test] Popup closed — waiting for prefill...');

        // ── 7. Assert the parent window received the postMessage and the ──
        // button moved to its success state.
        await expect(
            page.getByRole('button', { name: /aadhaar kyc ✓/i }),
        ).toBeVisible({ timeout: 15_000 });

        // ── 8. Assert the form prefilled with eAadhaar data ──
        // We can't assert exact values (real Aadhaar), only non-emptiness +
        // basic shape. Scope to the Personal Information section to avoid
        // collisions with Vehicle Details placeholders.
        const fullName = await personalSection
            .getByPlaceholder('Vijay Sharma')
            .inputValue();
        expect(fullName.trim().length, 'full_name should be populated').toBeGreaterThan(1);

        // DatePicker renders 3 selects (Day / Month / Year) with aria-labels.
        const day = await page.getByLabel('Day', { exact: true }).inputValue();
        const month = await page.getByLabel('Month', { exact: true }).inputValue();
        const year = await page.getByLabel('Year', { exact: true }).inputValue();
        expect(day, 'DOB day should be set').not.toBe('');
        expect(month, 'DOB month should be set').not.toBe('');
        expect(year, 'DOB year should be set').not.toBe('');

        const address = await personalSection
            .getByPlaceholder(/Main Street/i)
            .first()
            .inputValue();
        expect(address.trim().length, 'current_address should be populated')
            .toBeGreaterThan(10);

        // ── 9. Assert the DB rows persisted correctly (optional) ──
        const dbUrl = process.env.DATABASE_URL;
        if (!dbUrl) {
            console.log(
                '[digilocker-test] DATABASE_URL not set — skipping DB assertions. UI checks passed.',
            );
            return;
        }

        const sql = postgres(dbUrl, { ssl: 'require', prepare: false });
        const db = drizzle(sql, { schema });
        try {
            const [txnRow] = await db
                .select()
                .from(schema.digilockerTransactions)
                .where(eq(schema.digilockerTransactions.id, transactionId))
                .limit(1);

            expect(txnRow, 'digilocker_transactions row should exist').toBeTruthy();
            expect(txnRow!.status).toBe('document_fetched');
            expect(txnRow!.aadhaar_extracted_data).toBeTruthy();
            expect(txnRow!.lead_id).toBeTruthy();
            expect(txnRow!.verification_id).toBeTruthy();

            const [verRow] = await db
                .select()
                .from(schema.kycVerifications)
                .where(eq(schema.kycVerifications.id, txnRow!.verification_id!))
                .limit(1);

            expect(verRow, 'kyc_verifications row should exist').toBeTruthy();
            expect(verRow!.verification_type).toBe('aadhaar');
            expect(verRow!.status).toBe('success');
            expect(verRow!.api_provider).toBe('decentro_digilocker');
            expect(verRow!.lead_id).toBe(txnRow!.lead_id);
        } finally {
            await sql.end({ timeout: 5 }).catch(() => {});
        }

        console.log('[digilocker-test] ✓ eAadhaar fetched, form prefilled, verification recorded');
    });

});
