# Dealer-Type Onboarding — Implementation Plan

**Feature:** Extend dealer onboarding to support three dealer categories — **New Battery Dealer**,
**Scrap / Old Battery Dealer**, and **Both** — each driving a branch in onboarding, a different
agreement template, and a different dashboard.

**Status:** Design / plan only. This document describes *how* to implement it. No code has been changed.

---

## 1. Background — what exists today

| Concern | Current state |
|---|---|
| **Onboarding** | 6-step Zustand wizard at `src/app/dealer-onboarding/page.tsx`, steps in `src/components/onboarding/steps/`. Autosaves to `dealer_onboarding_applications`. |
| **Dealer "type"** | The only type collected is `companyType` — a **legal structure** (sole-prop / partnership / pvt-ltd), *not* a product category. No New/Scrap/Both concept exists anywhere. |
| **Agreement** | One hardcoded HTML template (`buildTarangDealerAgreementHtml()` in `src/lib/agreement/dealer-agreement-template.ts`), rendered to PDF and sent to DigiO. Called from **exactly one place** (`create-agreement/route.ts:379`), triggered by admin after review, and **only when finance is enabled**. |
| **Dashboard** | Flat `dealer` role → `/dealer-portal`. Sidebar is a static array. The **only** existing "vary a dealer's features" mechanism is the `finance_enabled` boolean, surfaced via `/api/dealer/stats` and consumed by both `sidebar.tsx` and `DealerDashboard.tsx`. |

**Key insight:** all three features map onto patterns that already exist. `dealer_type` is threaded
exactly like `companyType`, and gated exactly like `finance_enabled`. This is additive plumbing, not
new architecture.

## Design decisions (agreed)

1. **Scrap = a sub-type of the `dealer` role** (a new `dealer_type` field), *not* the separate
   `scrap_vendor` entity. One dealer login; behaviour varies by `dealer_type`.
2. Dashboard = **type-gated modules**, reusing the `finance_enabled` gating pattern.
3. **Every** onboarded dealer gets an agreement — generation is **decoupled from the finance flag**.
4. Scrap and Combined agreement templates are **scaffolded with placeholder clauses** for legal to
   finalise later; the New Dealer Agreement already exists.

---

## 2. Data model — the foundation

Add one classification field, distinct from `company_type` (legal) and `role` (still `dealer`).

**Migration** — `drizzle/E-202_dealer_type.sql` (hand-written, idempotent, additive, per CLAUDE.md
conventions; E-202 is the next free number):

```sql
ALTER TABLE dealer_onboarding_applications ADD COLUMN IF NOT EXISTS dealer_type varchar(16);
ALTER TABLE dealer_onboarding_applications ADD COLUMN IF NOT EXISTS agreement_template_type varchar(24);
ALTER TABLE dealers ADD COLUMN IF NOT EXISTS dealer_type varchar(16);
-- Optional backfill of existing rows so legacy dealers behave as "new":
UPDATE dealer_onboarding_applications SET dealer_type = 'new' WHERE dealer_type IS NULL;
UPDATE dealers SET dealer_type = 'new' WHERE dealer_type IS NULL;
```

- Leave columns nullable (never `SET NOT NULL` on existing rows).
- `agreement_template_type` records *which* template was generated — no such column exists today.
- Add a row to `drizzle/MIGRATION_CHECKLIST.md`. Apply via **pgAdmin Query Tool** (Postgres is on
  AWS RDS). Re-running the file must be a no-op.
- Mirror both columns in `src/lib/db/schema.ts`: `dealerOnboardingApplications` (~line 2627) and
  `dealers` (~line 5774).

**Shared type:** define `export type DealerType = 'new' | 'scrap' | 'both' | ''` once (in
`src/components/onboarding/onboardingTypes.ts`) and reuse everywhere.

---

## 3. Feature 1 — Dealer-type branch in onboarding

Thread `dealerType` through the wizard the **same way `companyType` is already threaded**. Copy the
existing plumbing at each hop:

| Hop | File | Change |
|---|---|---|
| Type | `src/components/onboarding/onboardingTypes.ts` | Add `DealerType` union + `dealerType: DealerType` to `CompanyStepData`. |
| UI | `src/components/onboarding/steps/StepCompany.tsx` | Add a selector (radio cards or `<select>`) beside the existing Company Type field (lines 43-61 are the pattern). Options: New Battery / Scrap (Old) Battery / Both. |
| Store state | `src/store/onboardingStore.ts` | `dealerType: ""` in `initialState.company` (~L181); include in `buildSavePayload` (~L317) and `partializeOnboarding` company block (~L369); map `a.dealer_type` in `hydrateFromApplication` (~L553). |
| Validation | `src/components/onboarding/onboardingSchemas.ts` | Require `dealerType` on step 1 (alongside `companyType`). |
| Draft save | `src/app/api/dealer-onboarding/save/route.ts` | Add `dealerType` to `sharedFields`. |
| Submit | `src/app/api/dealer/onboarding/submit/route.ts` | Carry `dealer_type` into `applicationPayload`. |
| Activation | `src/app/api/admin/dealer-verifications/[dealerId]/approve/route.ts` | Copy `dealer_type` into `insert(dealers)` (~L423-453). |

**Optional step-branching:** if scrap-only dealers should skip battery/finance steps, gate step
visibility on `dealerType` in `nextStep`/`prevStep` (`onboardingStore.ts` ~L461-500) — the same
mechanism as the current finance 4→6 skip. Default: keep all steps for `new`/`both`; optionally let
`scrap` skip the Finance step. Confirm scope before adding skips.

---

## 4. Feature 2 — Multiple agreement templates

The agreement is one builder called from one place, so this is a clean single-fork change plus two
new builder functions.

**Mapping:** New → New Dealer Agreement · Scrap → Scrap Dealer Agreement · Both → Combined Agreement.

1. **Templates** — `src/lib/agreement/dealer-agreement-template.ts`
   - Keep `buildTarangDealerAgreementHtml()` as the **New Dealer Agreement**.
   - Add `buildScrapDealerAgreementHtml()` and `buildCombinedDealerAgreementHtml()` with the same
     `AgreementTemplateInput` signature, containing **placeholder clauses** clearly marked for legal.
   - Add a dispatcher `buildDealerAgreementHtml(templateType, data)` that selects by `dealer_type`.
     This is the single registry / decision point.
2. **Fork point** — `src/app/api/integrations/digio/create-agreement/route.ts:379`
   - Replace the direct `buildTarangDealerAgreementHtml({...})` call with
     `buildDealerAgreementHtml(templateType, {...})`, where `templateType` comes from the payload.
3. **Dispatch source** — `src/app/api/admin/dealer-verifications/[dealerId]/initiate-agreement/route.ts`
   - Read the application's `dealer_type`, pass it into the in-process `create-agreement` call, and
     persist the resolved value to `agreement_template_type` on the application row.
4. **Decouple from finance** (per decision: every dealer gets an agreement)
   - `src/components/onboarding/steps/StepAgreement.tsx` currently renders only when
     `finance.enableFinance === "yes"` → make it render for all dealers; gate only the OEM/financier
     **sub-fields** on `finance = yes`.
   - Remove the finance-based 4→6 skip in `onboardingStore.ts` (`nextStep` ~L470-478,
     `prevStep` ~L492-494) so the agreement step is always reachable. (If a scrap-skip is added in
     Feature 1, branch on `dealer_type` instead of the finance flag.)
   - Ensure the admin "initiate agreement" action has no finance-only guard blocking non-finance dealers.

Everything else in the agreement flow — DB columns, signer tables, DigiO upload, e-stamp, webhook,
audit trail — is **reused unchanged**. Only template selection changes. See `docs/initiate-agreement-flow.md`.

---

## 5. Feature 3 — Dashboard access by dealer type

Reuse the **exact `finance_enabled` gating pattern**. No new role, no middleware route changes (same
`dealer` role → `/dealer-portal`).

1. **Expose the flag** — `src/app/api/dealer/stats/route.ts`
   - Add `dealerType: dealerApp.dealer_type` to the returned `dealer` object (beside the existing
     `financeEnabled`, ~L133).
2. **Sidebar** — `src/components/layout/sidebar.tsx`
   - Extend the existing dealer filter (~L1386-1416), which already fetches `/api/dealer/stats` and
     strips `loans`/`loan-mgmt` when finance is off. Read `dealerType` from the same response and
     filter the static `roleNavigation.dealer` array:
     - `scrap` → show only the **BATTERY BUYBACK** section; hide sales/inventory items.
     - `new` → hide the buyback-selling section; show sales/loans/inventory/orders/service.
     - `both` → show everything (current behaviour).
   - Define the item-id sets the same way `financeGatedItemIds` is defined (~L1409).
3. **Dashboard tiles** — `src/components/dealer-dashboard/DealerDashboard.tsx`
   - Gate metric tiles / action cards on `dealerType` exactly as `isFinanceEnabled` already does
     (~L378-385, L691-697, L734).

**Enforcement level:** this matches the existing precedent — **presentation-level** gating (hides
menus/tiles), not hard server RBAC. If enforced per-module back-end access control is required, that
is a larger separate effort (per-route guards in `src/middleware.ts` / route handlers) and is **out
of scope** here unless explicitly requested.

---

## 6. Files touched (summary)

| Area | Files |
|---|---|
| Migration + schema | `drizzle/E-202_dealer_type.sql`, `drizzle/MIGRATION_CHECKLIST.md`, `src/lib/db/schema.ts` |
| Wizard field | `onboardingTypes.ts`, `steps/StepCompany.tsx`, `onboardingStore.ts`, `onboardingSchemas.ts` |
| Onboarding APIs | `api/dealer-onboarding/save/route.ts`, `api/dealer/onboarding/submit/route.ts`, `api/admin/dealer-verifications/[dealerId]/approve/route.ts` |
| Agreement templates | `lib/agreement/dealer-agreement-template.ts`, `api/integrations/digio/create-agreement/route.ts`, `api/admin/dealer-verifications/[dealerId]/initiate-agreement/route.ts`, `steps/StepAgreement.tsx` |
| Dashboard gating | `api/dealer/stats/route.ts`, `components/layout/sidebar.tsx`, `components/dealer-dashboard/DealerDashboard.tsx` |

---

## 7. Verification

1. **Migration** — apply `E-202` in pgAdmin; re-run to confirm no-op. Verify `dealer_type` on both
   tables (`\d dealer_onboarding_applications`, `\d dealers`).
2. **Onboarding branch** — `npm run dev`, open `/dealer-onboarding`, pick each type at Step 1. Confirm
   it autosaves and survives a refresh/resume (`?applicationId=`).
3. **Agreement selection** — submit + approve a dealer of each type, trigger "initiate agreement" from
   `admin/dealer-verification/[dealerId]`, confirm the correct template PDF (new / scrap-placeholder /
   combined-placeholder) and that `agreement_template_type` is recorded. Verify a **non-finance**
   dealer still gets an agreement.
4. **Dashboard gating** — log in as an approved dealer of each type; confirm sidebar + tiles show only
   the type-appropriate modules; `both` shows everything.
5. **Regression** — `npm run type-check` and `npm run lint`, filtered to touched files (baseline is
   already red on unrelated files).

---

## 8. Open questions before build

- **Scrap step-skipping:** should scrap-only dealers skip the Finance step (and any battery-specific
  compliance docs), or complete the full wizard?
- **Agreement content:** Scrap and Combined templates ship as placeholders — who provides the final
  legal text, and by when?
- **Enforcement depth:** is presentation-level module gating sufficient, or is enforced back-end RBAC
  per module required (larger scope)?
