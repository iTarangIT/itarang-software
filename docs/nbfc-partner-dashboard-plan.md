# NBFC Partner Dashboard — Setup & Workflow Plan

> Scope: **NBFC Partner portal only** (tenant-facing dashboard at `/nbfc`).
> Source of truth: **NBFC Telemetry & Admin BRD, Section 6** (priority #1).
> Visual target: the deployed demo at `https://itarang.vercel.app/nbfc` ("NBFC Risk Manager" = same as our "NBFC Partner").
> This document is a **plan only — no code changes are made by it.**

---

## Context

iTarang already ships a substantial NBFC Partner portal: 10 routes under `/nbfc`, ~46 components, 72+ API endpoints, ~29 migrations, and a full brand-token CSS system. However, an architecture audit shows the portal is **scaffolded but not fintech-grade** — every screen renders, but the BRD-mandated drill-downs, the score-explainability feature, and the immobilisation compliance gate are either dead code or bypassed.

The goal of this plan: take the NBFC Partner portal from "all screens present" to "BRD-complete, compliance-correct, demo-matched." The portal is what an NBFC's own risk team logs into — it must behave like a real lending-partner risk console (RBI Digital Lending Directions 2025 + DPDPA 2023 compliant), not a CRM screen.

**Important constraint:** the deployed demo is login-gated (`admin@itarang.demo` / `demo`) and could not be inspected while writing this plan. The user wants the UI to **match the demo exactly** — so Phase 0 of the roadmap is a mandatory demo-capture step before any UI work begins.

---

## 1. What exists today (audit summary)

| Screen | Route | Maturity |
|---|---|---|
| Portfolio Overview | `/nbfc/portfolio` | **Partial** — 7 cards + freshness badge live; no trend/drill-through; delinquency is a DPD proxy |
| Lead Intelligence | `/nbfc/leads` | **Partial** — filters + CDS bands + EMI column; **lead detail modal missing** |
| Battery Monitoring | `/nbfc/batteries` | **Partial** — fleet table + drawer; history charts unwired; score badges not clickable |
| Risk Alerts | `/nbfc/risk` | **Partial** — hypothesis cards + severity tabs; action launchers are static copy |
| Recovery & Auction | `/nbfc/recovery` | **Partial** — kanban + eval wizard + lots; **immobilisation skips borrower notice** |
| Auction Marketplace | `/nbfc/auction` | **Partial** — duplicates the recovery-page auction section |
| Audit Log | `/nbfc/audit` | **Complete (basic)** — two tabs + filters; no export trigger |
| Settings | `/nbfc/settings` | **Complete (basic)** — users, notification prefs, read-only thresholds |
| Fleet Overview | `/nbfc/overview` | **Complete (basic)** — likely redundant vs Portfolio + Batteries |
| Root + Layout | `/nbfc`, `layout.tsx` | **Complete** — redirect + navy sidebar/header |

No screen is a pure stub. The weakness is **depth, BRD drill-downs, and one compliance bypass.**

The biggest single defect: `src/components/nbfc/scores/ScoreExplainabilityDrawer.tsx` is a **fully-built, BRD-§6.4.5-complete component with zero importers**, and its API reads tables (`nbfc_score_runs`, `nbfc_score_input_snapshots`) that **nothing writes**.

---

## 2. The fintech-grade NBFC dashboard workflow (BRD-driven)

This is the operating model the portal must support end-to-end.

### 2.1 Roles & tenant isolation
- The portal is **multi-tenant**. Every query is scoped `WHERE nbfc_id = token.nbfc_id`; cross-tenant access returns `403` and logs to the security audit (BRD §6.1.1).
- Portal user roles (BRD §6.4.3 dual-approval): **NBFC Viewer**, **NBFC Risk Manager** (initiator), **NBFC Risk Head** / **Credit Manager** (second approver).
- Resolved via `src/lib/nbfc/tenant.ts` → `getCurrentTenant()` / `requireNbfcAccess()`. Middleware maps role `nbfc_partner` → `/nbfc` (`src/middleware.ts`).

### 2.2 The daily operating loop
1. **Portfolio Overview** — open the book: AUM, active loans, disbursement-this-month, delinquency rate, avg portfolio CDS, recovery value locked. Check the **data-freshness badge** (amber if telemetry/CDS > 24 h stale).
2. **Risk Alerts** — triage what the overnight scoring + telemetry rules surfaced (EMI overdue, usage drop, battery offline, geo-shift, BMS fault, SOH decline).
3. **Lead Intelligence** — filter the loan book by status / CDS band / geography / product; open a borrower's **read-only detail drawer**.
4. **Battery Monitoring** — inspect SOC/SOH/GPS, click any **CDS/PCI badge → explainability drawer** (formula, last-6-EMI table, confidence, "when not to trust", override path).
5. **Take a governed action** — payment reminder (single), field visit (single, manager), **immobilisation** (dual-approval + mandatory borrower notice), restructuring (dual-approval), flag-for-recovery (single, risk head).
6. **Recovery & Auction** — move recovered batteries through `Needs Inspection → Refurbishable / Scrap → Ready for Auction → Resold`; run the 3-step evaluation; manage auction lots, bidding, settlement.
7. **Audit Log** — every action is immutably recorded (RBI DLD 2025); export with dual-approval when a regulator asks.

### 2.3 Data lifecycle (the engine behind the screens)
```
Loan sanctioned (loan_sanctions.nbfc_id FK)  ─┐
EMI ledger (emi_schedules)  ───────────────────┤
IoT telemetry every 15 min ──► iot_devices + telemetry_ingestion_log
                                      │
        ┌─────────────────────────────┴───────────────┐
   Nightly CDS job                              Nightly PCI job
   computeCds.ts ──► borrower_risk_scores        computePci.ts ──► borrower_risk_scores
                 └─► nbfc_score_runs +                          └─► nbfc_risk_alerts (pci_low)
                     nbfc_score_input_snapshots
                                      │
   Alert rules (per packet) ──► nbfc_risk_alerts / battery_alerts
                                      │
        Portfolio · Leads · Batteries · Risk screens read it
                                      │
        Action initiated ──► dual_approval_requests (24 h TTL)
                                      │
        Approved ──► action executes ──► nbfc_audit_log (immutable)
```
Background crons: telemetry ingest, nightly CDS, **nightly PCI** (currently unregistered — see §3.3), alert evaluation, dual-approval expiry sweep, DPDPA retention.

### 2.4 The action-governance chain (BRD §6.1.6)
Every borrower-impacting action follows **Evidence → Decision → Action → Audit**, tiered:

| Action | Approval | Reversible | Mandatory UI gate |
|---|---|---|---|
| Send Payment Reminder | Single (Risk Manager) | n/a | — |
| Request Field Visit | Single (Manager) | yes | reason required |
| **Request Immobilisation** | **Dual (Risk Mgr → Risk Head)** | **yes** | **Borrower Notice Preview + "I confirm" checkbox** |
| Loan Restructuring | Dual (Risk Mgr → Credit Mgr) | depends | before/after terms logged |
| Flag for Recovery | Single (Risk Head) | no | — |
| Audit Log Export / PII Access | Dual (Requestor MFA → Compliance) | n/a | — |

---

## 3. Gap analysis — current code vs BRD

### 3.1 Four-pillar gaps (all four are user-confirmed priorities)

**Pillar A — Portfolio & Lead Intelligence (§6.1.3–6.1.4)**
- Lead detail modal **not built** — `leads/page.tsx:357` renders a `?focus=` anchor that navigates nowhere. §6.1.4 mandates a clickable read-only detail modal.
- Missing **geography / product** filters (only status / CDS-band / date / text exist).
- CDS join is **fragile** — `borrower_risk_scores.loan_sanction_id` is `uuid` but `loan_sanctions.id` is `varchar`; the page silently degrades to "—".
- Delinquency is a **proxy** off `nbfc_loans.current_dpd`, not a real per-EMI computation (`portfolio-summary.ts:88`).
- Battery Serial column reads `nbfc_loans.vehicleno`; BRD §6.1.4 specifies `inventory.serial_number`.

**Pillar B — Battery Risk CDS/PCI (§6.1.5, §6.4.5)**
- **`ScoreExplainabilityDrawer.tsx` is fully built but has zero importers.** §6.4.5 ("every score badge is clickable → side drawer") is unmet — badges render as plain `<span>`s in `batteries/page.tsx` and `BatteryRowDrawer.tsx`.
- **Data break:** explainability API reads `nbfc_score_runs` + `nbfc_score_input_snapshots`; the nightly CDS job writes **only** `borrower_risk_scores`. The API returns `SCORE_NOT_COMPUTED` for every loan.
- **PCI never refreshes in prod** — `compute-pci` cron route exists but is **not registered in `vercel.json`**.
- Battery SOC/SOH/GPS **history charts not wired** (`BatteryRowDrawer.tsx:285` defers it; endpoints already exist).
- CDS thresholds **inconsistent** — `leads/page.tsx` reads 40/70 from `nbfc_risk_rules`; `batteries/page.tsx:45` hardcodes 40/70/85.

**Pillar C — Risk Actions & Dual-Approval (§6.1.6, §6.4)**
- Dual-approval **engine is solid** — `dual-approval/service.ts` enforces 24 h TTL, no self-approve, role match, idempotent dispatch, audit logging.
- **Compliance bypass:** `RecoveryKanban.tsx:192` defines its own `ImmobilisationRequestModal` that posts straight to the initiate API with only IMEI + reason — **no borrower notice, no confirm checkbox, no reversibility disclosure.** This violates §6.1.6. The correct component (`ImmobilisationRequestDialog` + `BorrowerNoticePreview`, all 5 elements present) exists but is only reachable from a `loop-test` page.
- `RiskActionFramework.tsx` is **informational only** — disabled checkbox, `₹<outstanding>` placeholder.
- `SendPaymentReminderButton`, `FlagForRecoveryDialog` are **built but not mounted** on any real screen — single-approval actions have no portal entry point.

**Pillar D — Recovery & Auction (§6.1.7)**
- 3-step evaluation wizard is **feature-complete** (minor: header says "Step X of 3" while step ranges 1–4).
- Auction is BRD-aligned (lot fields, min-next-bid, countdown, binding confirmation, auto-bid, settlement table).
- **Two auction surfaces** — `recovery/page.tsx` server-renders lots; `auction/page.tsx` client-fetches them. Consolidate.
- **No SOH guardrail** on kanban stage transitions (BRD: Refurbishable > 70 %, Scrap < 55 %).

### 3.2 Cross-cutting issues
- **No React Query** in the NBFC portal despite it being installed and used elsewhere (`Providers.tsx`). Client components use raw `fetch` + `useState`/`useEffect` with no retry/caching.
- `/nbfc/overview` overlaps Portfolio + Batteries and still references "Phase D" — candidate for removal.

### 3.3 Missing data plumbing (must fix or features stay inert)
1. `nbfc_score_runs` / `nbfc_score_input_snapshots` — read by the explainability API, **written by nothing**.
2. `compute-pci` cron — route exists, **absent from `vercel.json`**.
3. `telemetry_ingestion_log` — confirm `/api/iot/ingest` writes per-tenant rows, else freshness badge is permanently stale and CDS confidence is suppressed.
4. Audit-log export — service + initiate API exist; **no UI button** triggers it.
5. `ScoreExplainabilityDrawer` — built, zero importers.
6. `SendPaymentReminderButton`, `FlagForRecoveryDialog` — built, not mounted.

---

## 4. UI standard — matching the deployed demo

The user requirement is **"match the deployed demo exactly."** The demo is login-gated and could not be captured during planning. Therefore:

- **Phase 0 (mandatory, before any UI work):** log into `https://itarang.vercel.app/nbfc`, screenshot **every** NBFC screen and key interaction state (cards, drawers, modals, empty/loading/error states), and save them as the design reference (e.g. `docs/nbfc-demo-reference/`).
- Until then, the **BRD §6.B brand spec is the baseline** and is already implemented in `src/app/globals.css` — tokens `--brand-sky #138fc6`, `--brand-navy #02314e`, `--brand-teal`, `--color-success/warning/danger`, DM Sans / DM Mono typography. **Never hard-code hex** — always use tokens.
- The UI work in each phase below is then: implement the feature, then style it to the captured demo screenshot, verifying it uses §6.B tokens (no deviations).

---

## 5. Phased implementation roadmap

> Effort labels are relative (S/M/L). Each phase is independently shippable.

### Phase 0 — Capture the demo reference (S)
- Screenshot all NBFC demo screens + states; commit to `docs/nbfc-demo-reference/`.
- Diff demo screens against current `/nbfc` screens; record concrete visual deltas.
- **Output:** the visual spec every later phase styles against.

### Phase 1 — Score explainability end-to-end (Pillar B · §6.1.5 + §6.4.5) (L)
The highest-leverage fix — a fully-coded feature is inert purely from a data-plumbing break.
- `src/lib/nbfc/cds/computeCds.ts` — also write `nbfc_score_runs` + `nbfc_score_input_snapshots` **(or** repoint the explainability API at `borrower_risk_scores` + `emi_schedules`; pick one and document it).
- `vercel.json` — register `/api/cron/nbfc/compute-pci`.
- Wire `ScoreExplainabilityDrawer` into `batteries/page.tsx`, `BatteryRowDrawer.tsx`, and `leads/page.tsx` — every CDS/PCI badge becomes a clickable button.
- Unify CDS thresholds: read 40/70/85 from `nbfc_risk_rules` everywhere (remove the `batteries/page.tsx:45` hardcode).
- Confirm `/api/iot/ingest` writes `telemetry_ingestion_log` per tenant.

### Phase 2 — Immobilisation borrower-notice compliance (Pillar C · §6.1.6 + §6.4) (M)
A regulatory bug — no immobilisation request may be submitted without the notice.
- `RecoveryKanban.tsx` — delete the inline `ImmobilisationRequestModal`; route through `ImmobilisationRequestDialog` / `BorrowerNoticePreview` (5 elements + reversibility disclosure + "I confirm" checkbox gating submit).
- Mount `SendPaymentReminderButton`, `FlagForRecoveryDialog`, and field-visit / restructuring launchers on the risk cards and the new lead detail drawer.
- `RiskActionFramework.tsx` — keep the §6.1.6 matrix; route its live preview through the real dialog instead of static copy.
- Verify the dual-approval gate end-to-end: initiate → second approver notified → approve/reject → audit entry.

### Phase 3 — Lead Intelligence detail + portfolio depth (Pillar A · §6.1.3–6.1.4) (M)
- `leads/page.tsx` — build the read-only **lead detail modal/drawer** (customer, loan terms, EMI history, CDS/PCI, telemetry summary, action launchers).
- Add **geography + product** filters.
- Fix the `uuid`/`varchar` CDS join (align key types or add a resolved mapping).
- `portfolio-summary.ts` — replace the DPD proxy with `emi_schedules`-derived delinquency; add card trend/sparkline + drill-through to filtered Lead Intelligence.

### Phase 4 — Recovery & Auction polish + consolidation (Pillar D · §6.1.7) (M)
- Consolidate `auction/page.tsx` into the recovery surface (single marketplace with settlement context), or make one canonical auction route.
- `RecoveryKanban.tsx` — enforce SOH stage guardrails (> 70 % Refurbishable, < 55 % Scrap).
- `BatteryEvaluationWizard.tsx` — fix the step counter (1–4 vs "of 3").

### Phase 5 — Consistency, audit export & hardening (cross-cutting · §6.4) (M)
- Migrate NBFC client components (`PortfolioSummaryCards`, `DataFreshnessBadge`, `auction/page.tsx`, action dialogs) to **React Query** — `staleTime`, retry, optimistic mutations. `Providers.tsx` already wraps the app.
- `audit/page.tsx` — add the CSV/PDF **export trigger** wired to `audit-export/service.ts` behind the dual-approval gate.
- `BatteryRowDrawer.tsx` — wire SOC/SOH/GPS **history charts** off the existing IoT endpoints.
- Decide the fate of `/nbfc/overview` (remove or repurpose).
- Full §6.B brand-token audit across every NBFC screen against the Phase 0 demo screenshots.

---

## 6. Critical files

| Concern | Path |
|---|---|
| CDS nightly job (needs score-run writes) | `src/lib/nbfc/cds/computeCds.ts` |
| PCI nightly job | `src/lib/nbfc/pci/computePci.ts` |
| Cron registration | `vercel.json` |
| Explainability drawer (wire up) | `src/components/nbfc/scores/ScoreExplainabilityDrawer.tsx` |
| Explainability API | `src/app/api/nbfc/scores/explainability/route.ts` |
| Immobilisation bypass (fix) | `src/app/(dashboard)/nbfc/recovery/_components/RecoveryKanban.tsx` |
| Correct immobilisation flow | `src/components/nbfc-portal/ImmobilisationRequestDialog.tsx`, `BorrowerNoticePreview.tsx` |
| Dual-approval engine | `src/lib/nbfc/dual-approval/service.ts` |
| Lead Intelligence | `src/app/(dashboard)/nbfc/leads/page.tsx` |
| Battery Monitoring | `src/app/(dashboard)/nbfc/batteries/page.tsx`, `_components/BatteryRowDrawer.tsx` |
| Portfolio summary | `src/lib/nbfc/portfolio-summary.ts`, `portfolio-freshness.ts` |
| Recovery / eval wizard | `src/app/(dashboard)/nbfc/recovery/page.tsx`, `_components/BatteryEvaluationWizard.tsx` |
| Tenant scoping | `src/lib/nbfc/tenant.ts` |
| Brand tokens | `src/app/globals.css` |

---

## 7. Verification plan

For each phase, verify end-to-end logged in as an NBFC portal user (role `nbfc_partner`):

- **Phase 1:** run the CDS + PCI crons; confirm `nbfc_score_runs` rows appear; open `/nbfc/batteries`, click a CDS badge → drawer shows formula, last-6-EMI table, confidence badge, "when not to trust", override CTA (role-gated). Confirm `compute-pci` runs on schedule.
- **Phase 2:** from the recovery kanban, attempt immobilisation → borrower notice preview appears with all 5 elements + reversibility line; submit is disabled until "I confirm" is checked; after submit, a `dual_approval_requests` row exists; second approver sees it; approve → IoT command fires, `nbfc_audit_log` entry written; let one expire past 24 h → auto-cancels.
- **Phase 3:** click a lead reference ID → read-only detail drawer opens; geography/product filters narrow results; CDS column shows real values (no "—" from key mismatch); delinquency card matches an independent `emi_schedules` query.
- **Phase 4:** move a battery through recovery stages — transition to Refurbishable blocked when SOH < 70 %; auction lot bidding enforces min-next-bid; settlement advances Payment Pending → Delivered.
- **Phase 5:** throttle the network — React Query screens retry and show cached data; audit export produces a file behind dual-approval; battery drawer renders SOC/SOH history charts.
- **UI:** every screen diffed against the Phase 0 demo screenshots; computed styles use `--brand-*` / `--color-*` tokens (no raw hex).

Run locally with `npm run dev` (Next.js + BullMQ worker). No test suite exists — verification is manual + DB inspection.

---

## 8. Open questions / risks

1. **Demo access** — the demo could not be logged into while writing this plan. If the demo contains screens or flows **not in the BRD**, Phase 0 must surface them and they should be added to this plan before building.
2. **`nbfc_score_runs` decision** — Phase 1 must choose: (a) make the CDS job write score-run + snapshot rows, or (b) repoint the API at `borrower_risk_scores` + `emi_schedules`. Option (a) preserves the BRD §6.4.5 audit-snapshot intent; option (b) is faster. Recommendation: **(a)**.
3. **Deployment** — sandbox/prod run on **Hostinger VPS + PM2**, not Vercel. The `compute-pci` cron registration in Phase 1 must also be reflected in whatever PM2/cron mechanism the VPS uses, not only `vercel.json`.
4. **Schema changes** — any new column/index must be a hand-written idempotent `drizzle/E-XXX_*.sql` migration mirrored into `schema.ts`. **Do not run `npm run db:push`** against shared environments.
5. **`/nbfc/overview` redundancy** — confirm with the team whether it should be deleted (Phase 5).
