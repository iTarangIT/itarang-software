# Ecofy CRM / LMS — Gap Audit (tracker ID 51)

Read-only audit of `main` @ `5d6010a5` (1 Oct 2026). Each finding is taken from the code; nothing was run against Ecofy. The Ecofy Developer Handoff v1.4 (Drive zip) was not available in the repo, so these gaps are measured against the requirement text and `docs/ECOFY_INTEGRATION.md`.

## How it works

- **Ownership.** Ecofy owns the case and its stages S0–S8 / CLOSED. The CRM mirrors each lead in `ecofy_leads`, keyed by `ecofy_case_id`.
- **Ecofy → CRM.** Signed events arrive at `POST /api/integrations/ecofy/events`; the code is in `src/lib/ecofy/inbound.ts`.
- **CRM → Ecofy.** There are two channels:
  - The §4 event channel (`src/lib/ecofy/outbound.ts`) only ever sends `lead.assigned`.
  - Every other write goes through the §5 signed API (`src/lib/ecofy/api.ts`, `service.ts`), called from `POST /api/ecofy/leads/[id]/actions` (zod schemas in `actionSchemas.ts`) and `/documents`.
- **Roles** (`src/lib/ecofy/access.ts`):
  - Manager = `sales_head` and `ceo`; they can do everything.
  - Worker = `asm` and `inside_sales_rep`; they can only work leads assigned to them.
  - Ecofy sees every call as a single integration Admin, so the CRM is the only place these role limits are enforced.
- **Tables:**
  - `ecofy_leads` and `ecofy_sync_events` (E-305)
  - owner and reminder columns plus `ecofy_lead_assignments` (E-307)
  - `ecofy_lead_activities`, the offline work log (E-308)
- **Lead screen.** Every role uses one detail screen, `src/components/ecofy/EcofyLeadDetail.tsx`: a step card (`stepBrief.ts`) and eight tabs (Timeline, Activities, Appointments, Assessment, Offer, Financing, Installation, Documents).

## Summary

| # | Stage | Status | Main implementation | Roles | Writes back to Ecofy? |
|---|---|---|---|---|---|
| 1 | Ecofy qualification (S0) | **Missing** (by design, Ecofy-only) | S0 label/step text only; owner cleared on return to S0 | read-only | No |
| 2 | iTarang pickup queue (S1) | **Built** | `/sales-head/ecofy/queue`, `/sales-head/ecofy`, `EcofyAssignBar`, `POST /api/ecofy/assign`, `lib/ecofy/assignment.ts` | SH, CEO | Yes (`lead.assigned` S1→S2; `/return`) |
| 3 | iTarang lead follow-up (S2) | **Built** | Activities/Appointments tabs, `CrmWorkLog`, reminders, offline replay | SH/CEO all; ASM/ISR assigned | Yes (activities, appointments, advance, close) |
| 4 | Requirement assessment (S3) | **Partial** | Assessment tab (`NewAssessmentForm`, `AssessmentCard`) | SH/CEO; assigned ASM/ISR | Yes, MANUAL/EPC only |
| 5 | Eligibility + EPC quote (S4) | **Built** (Ecofy-lender caveat) | Offer tab; `/sales-head/ecofy/eligibility` + `EligibilityDecision` | request/quote: SH + assigned; decision: SH/CEO | Yes |
| 6 | Customer acceptance (S5) | **Built** | `OfferOtpBlock` (send/verify OTP) | SH; assigned ASM/ISR | Yes |
| 7 | Ecofy sanction (S6) | **Partial** | `FinancingDecisionForm`, `RouteFinancierRow`, `/sales-head/ecofy/financing` (read-only) | SH/CEO | Non-Ecofy financiers only |
| 8 | Installation / disbursement (S7) | **Built** (Ecofy-lender caveat) | Installation + Financing tabs, document uploads | install: SH + assigned; money: SH/CEO | Yes |
| 9 | Active asset tracking (S8) | **Partial** (read-only mirror) | `/sales-head/ecofy/assets` (live `GET /assets?limit=100`) | SH/CEO | No |
| 10 | Energy calculator | **Built** (one gap) | calculator pages ×3 roles, `EcofyCalculator.tsx`, designer | all four; designer SH/CEO | Estimates are not stored |
| 11 | Lead uploader | **Missing** | none (generic uploaders write `dealer_leads` only) | — | No `POST /cases` |

## Gaps to build, by priority

1. **Lead uploader (stage 11).**
   - No bulk or single-lead creation path exists for Ecofy leads, and the CRM never calls Ecofy `POST /cases`.
   - Today leads only enter through Ecofy's push.
   - **Needs:** the Ecofy create-case contract (the handoff zip and openapi `docs/ecofy_openapi_v1.0.1.yaml`, which is not in the repo).
2. **Calculator result → assessment (stages 4 and 10).**
   - A calculator run cannot be attached to a lead; it has to be re-typed as a MANUAL assessment.
   - There is no recommended-vs-selected override (`selectedCode` / `overrideReason` are display-only).
3. **Active asset tracking (stage 9).**
   - The view is read-only, capped at 100 rows, and stores nothing in the CRM.
   - Missing: EMI updates, buyback/redeploy, service events, an ASM/ISR view, and a link to the NBFC EMI tracker or buyback modules.
4. **Ecofy-financed sanction, down payment and disbursement (stages 7 and 8).**
   - The CRM can only wait on these, because Ecofy's own amounts are hidden from the integration user.
   - The re-acceptance OTP can only be triggered from Ecofy.
   - Needs a business decision on whether the CRM should record these at all.
5. **Qualification (stage 1).** No CRM screen exists. This is by design; confirm it with the business.
6. **Smaller gaps:**
   - The financing queue page has no actions.
   - Quote request is a log entry only; no email or WhatsApp is actually sent to the EPC.
   - `update_appointment` is not covered by the offline fallback.
   - `WithdrawalTab` is fully written but not rendered (dead UI).
   - Only `lead.assigned` of the §4 events is used.
   - Ecofy audit cannot attribute actions to a person: the actor name is always "iTarang CRM" and no per-user `X-Itarang-Act-As` is sent.
   - Ecofy leads live outside `dealer_leads`, so they are absent from the main funnels, reports and AI tooling.
   - Assignment is saved in the CRM first; telling Ecofy is best-effort, with a resend path.

## Verification coverage

- `scripts/verify-ecofy-workspace.ts` makes read-only checks.
- `scripts/verify-ecofy-e2e.ts` drives S1→S6 on one sandbox lead. Nothing scripts S6→S8.
- Unit tests cover access, signature, stepBrief and the client. There are no route or page tests.

## Open items from `docs/ECOFY_INTEGRATION.md`

1. The doc references `docs/CONFLICTS.md` and `docs/ecofy_openapi_v1.0.1.yaml`; neither is in the repo.
2. The env names on the two sides are not mapped to each other: Ecofy uses `ITARANG_CRM_*`, the CRM uses `ECOFY_SYNC_SECRET` / `ECOFY_EVENTS_URL` / `ECOFY_API_BASE`.
3. When the secret is missing, the CRM's inbound route answers 503; the doc says 404.
4. The CRM chose a separate `ecofy_leads` table over `leads` with `source='ECOFY'`, which is why Ecofy leads are outside the CRM funnels.
5. The CRM uses the §4 events and the §5 API together; the doc says either one. `lead.accepted` is never sent.
6. Ecofy-side operations (its migrations and creating the integration user) have no CRM runbook.

## Next step

Unpack `Ecofy_Developer_Handoff_v1.4.zip` into `docs/ecofy-handoff/`, then plan gaps 1–3 as a separate phase against that spec.
