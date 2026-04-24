# Playwright E2E Test Suite

## Quick start

```bash
# Install (first time)
npm i -D @playwright/test cross-env dotenv
npx playwright install --with-deps chromium

# Populate test env (see .env.test.local)
# E2E_BASE_URL, E2E_TEST_PASSWORD, NEXT_PUBLIC_SUPABASE_URL,
# SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL

# Run everything stubbed (default)
npm run test:e2e

# Smoke only (fastest)
npm run test:e2e:smoke

# Watch a run in a real browser
HEADED=1 npm run test:e2e

# Generate the TL-facing Excel eval sheet
npm run test:e2e:eval
# → writes test-results/eval-report-YYYYMMDD-HHmmss.xlsx

# Opt-in suites
npm run test:e2e:live     # hits real Decentro/Digio — costs money
npm run test:e2e:manual   # requires human Aadhaar OTP entry
```

## Folder layout

```
tests/
  e2e/
    onboarding/              dealer onboarding wizard specs
    leads/                   dealer lead creation specs
    kyc/                     admin KYC review specs (+ not-implemented)
    live/                    opt-in: hits real paid APIs
    pages/                   Page Object Models
    factories/               per-test data builders (dealer/lead/kyc presets)
    helpers/                 api-stubs, db-seed, sample-docs, dealer-creds, onboarding-wizard
    fixtures.ts              shared test fixtures (noiseBlocker, stubbedApis, freshDealerLead, freshKycLead)
    global.setup.ts          sales_head + dealer storage-state login
  reporters/
    excel-reporter.ts        custom Playwright reporter → xlsx
```

## Test title tagging convention

Every test name ends with bracketed tokens. The Excel reporter parses them.

| Token group | Values | Meaning |
|---|---|---|
| Feature | `[onboarding]` / `[lead-creation]` / `[kyc-review]` / `[other]` | Used to populate the Feature column and Summary pivot |
| Tier | `[smoke]` / `[critical]` / `[happy-path]` | Priority. `[smoke]` is run in the fast gate |
| Mode | `[live]` / `[manual]` | Opt-in. Excluded from default run. `[live]` hits real APIs, `[manual]` needs a human |
| State | `[not-implemented]` | Paired with `test.skip(true, 'NOT_IMPLEMENTED: ...')`. Surfaces in the "Not Implemented" sheet |

Example:
```ts
test('creates dealer lead with warm/hinglish [lead-creation] [critical] [happy-path]', async ({ page }) => { ... });
```

## Page Object Models

- `pages/OnboardingWizardPage.ts` — `.goto()`, `.fillCompanyStep()`, `.clickNext()`, `.expectStep1Error()`. Static `runFullFlow()` delegates to the battle-tested `helpers/onboarding-wizard.ts` for multi-step + upload scenarios.
- `pages/LeadCreationPage.ts` — `.gotoNew()`, `.fillDealerLeadForm()`, `.submitAndWaitForRequest()`, `.expectValidationError()`.
- `pages/KycReviewPage.ts` — `.goto(leadId)`, `.card('pan'|'bank'|'aadhaar'|'cibil'|'rc')`, `.submitManualDecision()`. `VerificationCard.runVerification()` clicks and awaits the admin verify POST.

## Fixtures (`fixtures.ts`)

| Fixture | Auto? | Purpose |
|---|---|---|
| `noiseBlocker` | auto | Aborts maps/analytics, fulfills n8n/s3 — prevents flake from irrelevant third-parties |
| `stubbedApis` | opt-in | Installs Decentro/Digio/S3 route stubs; returns a controller to swap stub modes (`stubs.pan('mismatch')`) |
| `freshDealerLead` | opt-in | Seeds a row in `dealer_leads`, cleans up in teardown. Use for sales-head lead flows |
| `freshKycLead` | opt-in | Seeds a row in `leads` (customer lead) with `payment_method='finance'`. Use for `/admin/kyc-review/[leadId]` specs |

## Excel eval report

Generated only when `EXCEL_REPORT=1`. Three sheets:

1. **Results** — one row per test. Columns: Test ID, Feature, Scenario, Tags, Status, Duration (s), Error, Steps, Reason, Timestamp, Project. Status cells are color-coded (green/red/yellow/gray/orange).
2. **Summary** — pass-rate and per-feature pivot (Passed / Failed / Skipped–Not Implemented / Skipped–Other / Flaky / Total).
3. **Not Implemented** — filtered view of `test.skip(true, 'NOT_IMPLEMENTED: …')` entries, with the source pointer (file path) extracted from the reason.

File output: `test-results/eval-report-YYYYMMDD-HHmmss.xlsx`. Timestamped — never overwrites. `test-results/` is gitignored.

## "Not implemented" convention

When a backend route is documented but not built, file a skipped test with a structured reason that the reporter will surface:

```ts
test('co-borrower send-consent dispatches SMS [kyc-review] [not-implemented]', () => {
  test.skip(true, 'NOT_IMPLEMENTED: co-borrower SMS/WhatsApp (src/app/api/coborrower/[leadId]/send-consent/route.ts)');
});
```

Six such placeholders exist in `tests/e2e/kyc/not-implemented.spec.ts` — delete them when their routes are implemented.

## Gotchas

- **`/admin/kyc-review/[leadId]` expects customer leads, not dealer leads.** Use `freshKycLead` (seeds `leads`), not `freshDealerLead` (seeds `dealer_leads`).
- **`headless: false` is the default for `HEADED=1`** — turn on for debugging only. Eval runs always headless.
- **`workers: 1` is intentional** — sandbox can't handle parallel writes safely yet. POM + factories are parallel-safe when this is flipped.
- **Live specs write to the sandbox DB.** Run them sparingly; they mutate `accounts`, `dealer_onboarding_applications`, `kyc_verifications`.
- **OCR cached badge ≠ verification cached.** Every "Re-run PAN Verification" click hits Decentro live (paid API). See `src/lib/kyc/pan-verification.ts`.

## Failure artifacts

On failure: `test-results/<spec>-<title>-chromium/` contains:
- `test-failed-N.png` — screenshot at point of failure
- `video.webm` — full test recording (retain-on-failure)
- `error-context.md` — Playwright's AI-ready failure dump

HTML report: `npm run test:e2e:report`.
