# Ecofy CRM / LMS — Gap Audit (tracker ID 51)

Audit of `main` @ `5d6010a5` (1 Oct 2026), updated the same day after gaps 1–3 were built on branch `Aditya`. Each finding is taken from the code; nothing was run against Ecofy. The update is measured against the Ecofy Developer Handoff v1.4, now unpacked at `docs/ecofy-handoff/Ecofy_Developer_Handoff_v1.4/`: BRD v1.4 (product), `02_API_DATABASE/ecofy_openapi_v1.0.1.yaml` (API shape), the UAT v1.1 pack and the lead upload template v0.3.

## How it works

- **Ownership.** Ecofy owns the case and its stages S0–S8 / CLOSED. The CRM mirrors each lead in `ecofy_leads`, keyed by `ecofy_case_id`.
- **Ecofy → CRM.** Signed events arrive at `POST /api/integrations/ecofy/events`; the code is in `src/lib/ecofy/inbound.ts`.
- **CRM → Ecofy.** There are two channels:
  - The §4 event channel (`src/lib/ecofy/outbound.ts`) only ever sends `lead.assigned`.
  - Every other write goes through the §5 signed API (`src/lib/ecofy/api.ts`, `service.ts`), called from `POST /api/ecofy/leads/[id]/actions` (zod schemas in `actionSchemas.ts`), `/documents`, and now `/api/ecofy/cases` and `/api/ecofy/imports/**` (lead intake, schemas in `intake.ts`).
- **Roles** (`src/lib/ecofy/access.ts`):
  - Manager = `sales_head` and `ceo`; they can do everything.
  - Worker = `asm` and `inside_sales_rep`; they can only work leads assigned to them.
  - Ecofy sees every call as a single integration Admin (ITARANG_ADMIN), so the CRM is the only place these role limits are enforced.
- **Tables:**
  - `ecofy_leads` and `ecofy_sync_events` (E-305)
  - owner and reminder columns plus `ecofy_lead_assignments` (E-307)
  - `ecofy_lead_activities`, the offline work log (E-308)
  - No new tables or migrations for gaps 1–3.
- **Lead screen.** Every role uses one detail screen, `src/components/ecofy/EcofyLeadDetail.tsx`: a step card (`stepBrief.ts`) and eight tabs (Timeline, Activities, Appointments, Assessment, Offer, Financing, Installation, Documents).

## Summary

| # | Stage | Status | Main implementation | Roles | Writes back to Ecofy? |
|---|---|---|---|---|---|
| 1 | Ecofy qualification (S0) | **Ecofy-owned by contract** | S0 label/step text only; owner cleared on return to S0 | read-only | No (M04 users are EA/EU) |
| 2 | iTarang pickup queue (S1) | **Built** | `/sales-head/ecofy/queue`, `/sales-head/ecofy`, `EcofyAssignBar`, `POST /api/ecofy/assign`, `lib/ecofy/assignment.ts` | SH, CEO | Yes (`lead.assigned` S1→S2; `/return`) |
| 3 | iTarang lead follow-up (S2) | **Built** | Activities/Appointments tabs, `CrmWorkLog`, reminders, offline replay | SH/CEO all; ASM/ISR assigned | Yes (activities, appointments, advance, close) |
| 4 | Requirement assessment (S3) | **Built** | Assessment tab: Calculator / Manual / EPC (`NewAssessmentForm`, `CalculatorAssessmentSave`), `AssessmentCard` | SH/CEO; assigned ASM/ISR | Yes — CALCULATOR, MANUAL, EPC; selected system + override reason |
| 5 | Eligibility + EPC quote (S4) | **Built** (Ecofy-lender caveat) | Offer tab; `/sales-head/ecofy/eligibility` + `EligibilityDecision` | request/quote: SH + assigned; decision: SH/CEO | Yes |
| 6 | Customer acceptance (S5) | **Built** | `OfferOtpBlock` (send/verify OTP) | SH; assigned ASM/ISR | Yes |
| 7 | Ecofy sanction (S6) | **Partial** | `FinancingDecisionForm`, `RouteFinancierRow`, `/sales-head/ecofy/financing` (read-only) | SH/CEO | Non-Ecofy financiers only |
| 8 | Installation / disbursement (S7) | **Built** (Ecofy-lender caveat) | Installation + Financing tabs, document uploads | install: SH + assigned; money: SH/CEO | Yes |
| 9 | Active asset tracking (S8) | **Built** (read-only by contract) | `/sales-head/ecofy/assets` (all assets, no paging params) + `/sales-head/ecofy/assets/[assetId]` (`GET /assets/{id}`) | SH/CEO | No — EMI/buyback/redeploy are ECOFY_ADMIN-only |
| 10 | Energy calculator | **Built** | calculator pages ×3 roles, `EcofyCalculator.tsx`, designer; "Save to this lead's assessment" when opened from a lead | all four; designer SH/CEO | Quick estimates are never stored (FR-07.1); a saved run is a CALCULATOR assessment |
| 11 | Lead uploader | **Built** | `/sales-head/ecofy/upload` (single lead + bulk import wizard), `POST /api/ecofy/cases`, `/api/ecofy/imports/**` | SH, CEO | Yes — `POST /cases`, `/imports*` |

## What was built for gaps 1–3

### Gap 11 — lead uploader (BRD M03, OpenAPI M03 Intake)

- **Page:** `/sales-head/ecofy/upload` (`src/components/ecofy/EcofyLeadUploader.tsx`), "Upload Leads" in the Ecofy sub-nav (Sales Head and CEO share it). Managers only on every route (`ECOFY_MANAGER_ROLES`).
- **Single lead:** `POST /api/ecofy/cases` → Ecofy `POST /cases` with the required `Idempotency-Key` (one per form, reused on retry). Zod in `src/lib/ecofy/intake.ts` mirrors CustomerIn/CaseCreate: mobile `^[6-9][0-9]{9}$`, pincode `^[1-9][0-9]{5}$`, `consentObtained` const true, consent date + source required, segment RESI/ESS/CI, whole-rupee bill. Dropdowns come from Ecofy's own lists (`consent_source`, `language`, `property_type`, `product_interest`, `existing_backup`, `call_time`). As iTarang Admin the case lands at S1, owned by iTarang (CaseCreate description, FR-03.8). The returned Case is upserted into `ecofy_leads` through the same version-guarded upsert the inbound push uses (`upsertEcofyLeadSnapshot` + `caseToLeadSnapshot`), so it is in the pickup queue at once; the write is in `ecofy_sync_events` as `api:POST /cases`.
- **Bulk import:** template download (`GET /imports/template`, proxied), upload (`POST /imports` → UploadTicket → server-side PUT to `uploadUrl`; `.xlsx`/`.csv`, ≤ 10 MB), header row read server-side with `xlsx` (the template's "Leads" sheet), auto-mapping of headers equal to template columns (FR-03.3), `POST /imports/{id}/mapping` (optional `saveAs`), `POST /imports/{id}/validate` → counts + sample errors (FR-03.4), `POST /imports/{id}/commit` with `consentAttested: true`, the attestation text and an `Idempotency-Key` (FR-03.5), polling `GET /imports/{id}` until COMMITTED/FAILED, and the row report `GET /imports/{id}/report.csv` proxied through `/api/ecofy/imports/[id]/report`.

### Gaps 4 / 10 — calculator-based assessment (BRD M07, FR-07.2 / 07.8 / 07.11)

- `save_assessment` now takes `method: CALCULATOR | MANUAL | EPC` with `calculator` (CalcInput), `selectedSystemCode` and `overrideReason`; `toAssessmentCreate()` builds the exact AssessmentCreate body. A reason is required when the selected system differs from the recommendation (UAT-15). The CRM-only `recommendedSystemCode` is never sent.
- The Assessment tab offers Calculator (embedded `EcofyCalculator`), Manual and EPC. C&I: the calculator is hidden with "EPC quote required" (FR-07.11, UAT-14); the zod schema and the actions route both refuse a CALCULATOR assessment for C&I or for a segment other than the lead's.
- The standalone calculator opened from a lead (`?leadId=&caseNo=&back=`) locks the segment and offers "Save to this lead's assessment". Ecofy recomputes on save from the inputs, so the release id and every step come from Ecofy (UAT-10).

### Gap 9 — active asset tracking (BRD M13)

- `GET /assets` declares no parameters, so the CRM no longer sends `limit=100`; the page lists every asset Ecofy returns and says so.
- New asset detail page `/sales-head/ecofy/assets/[assetId]` (`GET /assets/{assetId}`), opened from the customer column. The response is an untyped object in OpenAPI, so it is rendered generically (`src/lib/ecofy/assetView.ts`).
- No writes: `POST /assets/{id}/emi-status` and `/events` are `x-roles: ECOFY_ADMIN` (FR-13.2, FR-13.3). The page copy says so.

### Tests

`src/lib/ecofy/__tests__/intake.test.ts` (CaseCreate, mapping, commit, file checks, Case → snapshot, header reading) and `assessment.test.ts` (AssessmentCreate rules, C&I/segment refusal, asset view).

## Ecofy-owned by contract (no CRM build)

| Item | Why the CRM does not write it | Spec reference |
|---|---|---|
| S0 qualification | Ecofy works its own base; M04 users are EA, EU | BRD M04; START_HERE §4 |
| EMI status, buyback, redeployment | `x-roles: ECOFY_ADMIN` only | BRD FR-13.2, FR-13.3; OpenAPI `post_assets_assetId_emi_status`, `post_assets_assetId_events`; UAT-29 |
| IoT / risk on assets | Out of scope | BRD FR-13.4; UAT-29 |
| Re-acceptance OTP trigger | `POST /cases/{id}/reacceptance` is `x-roles: ECOFY_ADMIN` | OpenAPI; BRD M11 |
| Import processing: dedupe, reopen, link, `assign_to` | Ecofy runs the commit as a background job | BRD FR-03.5, FR-03.6, FR-03.7 |
| Import retention purge | Ecofy job (`import.purge`) | BRD FR-03.10; UAT-31 |
| Credit / underwriting / money movement | Platform boundary | START_HERE §4, §7; UAT-35 |

## BRD / OpenAPI conflicts and interpretations (raise with iTarang)

1. **`CaseCreate.fromEstimateId` vs FR-07.1.** OpenAPI lets a create save "a quick-estimate snapshot as assessment v1", but BRD FR-07.1 says a quick estimate is never stored and `CalcResult` returns no estimate id. The CRM does not send `fromEstimateId`.
2. **Import size.** BRD FR-03.2 / template: up to 5,000 rows. OpenAPI `ImportStart`: ≤ 10,485,760 bytes, no row cap. The CRM enforces 10 MB and leaves the row cap to Ecofy.
3. **Who imports.** BRD M03 "Users: EA uploads" vs FR-03.9 "Imports by IA" and OpenAPI `/imports*` `x-roles: ECOFY_ADMIN, ITARANG_ADMIN`. The CRM follows OpenAPI + FR-03.9.
4. **`assign_to` on an iTarang import.** FR-03.7 assigns only to an active Ecofy User, but IA imports start at S1 owned by iTarang (FR-03.9). The CRM ignores `assign_to` and assigns in the CRM afterwards; the template column is still mappable.
5. **List fields are free strings in OpenAPI.** `consentSource`, `preferredLanguage`, `propertyType`, `productInterest`, `existingBackup`, `preferredCallTime` are `string` in CustomerIn/CaseCreate, but BRD §7.3 says "list code". The CRM sends the seed codes from Ecofy's `/lists` (lists `language` and `call_time`, not `preferred_language` / `preferred_call_time`).
6. **Consent date "not in the future"** is a §7.3 template conversion rule; the CRM applies it to the single-lead form too. OpenAPI only says `format: date`.
7. **Override with no recommendation.** AssessmentCreate needs `overrideReason` "when selectedSystemCode differs from the recommendation". The CRM treats "no recommendation" as different, so picking a system then needs a reason.
8. **CalcResult shape.** The CRM renders `pending`, `systemType`, `usableCapacityKwh`, etc., which OpenAPI `CalcResult` / `SystemOption` (`additionalProperties: false`) do not declare. Ecofy returns more than the contract; the CRM now tolerates a missing `pending`.
9. **File endpoints.** `/imports/template` and `/imports/{id}/report.csv` declare only `200 OK`. The CRM proxies either the file bytes or a `{ data: { url } }` envelope.
10. **UploadTicket has no `headers`.** Unlike document upload tickets, the CRM PUTs with the file's own Content-Type. If Ecofy presigns a different type, the PUT fails; this needs a sandbox check.
11. **Asset visibility for callers.** BRD M13 "others view status" vs OpenAPI `GET /assets*` `x-roles: ECOFY_ADMIN, ITARANG_ADMIN`. ITARANG_CALLER is excluded, so assets stay manager-only in the CRM (no ASM/ISR view).
12. **`GET /assets` is unpaginated.** It has no cursor/limit and no `Page` meta, so a large book returns in one response.

## Remaining gaps (not in this phase)

1. **Ecofy-financed sanction, down payment and disbursement (stages 7 and 8).** `financing/decisions`, `down-payment` and `disbursement` are `x-roles: ECOFY_ADMIN, ITARANG_ADMIN`, so the CRM *could* record them. Whether it should for Ecofy's own lending is a business decision (START_HERE: "financing decisions remain with Ecofy").
2. **Bulk-imported leads reach `ecofy_leads` only through Ecofy's push.** The import API returns counts, not case ids. Single creates are upserted at once.
3. **Smaller gaps.** Closed in the ID 51 follow-up:
   - ~~The financing queue page has no actions.~~ Each CRM-linked row now has "Open Financing tab" (`?tab=Financing` deep link, `src/lib/ecofy/leadTabs.ts`) and "Record decision", which reuses the lead screen's `FinancingDecisionForm` (`src/components/ecofy/FinancingQueueAction.tsx`). It goes through the same action route and access gate (Sales Head / CEO, S6), with If-Match set to the row's case version. FR-11.5: other financiers only, and Ecofy enforces the financier's role. A case that was never pushed to the CRM shows "decide in Ecofy". No Ecofy-financed sanction writes were added (item 1).
   - ~~`update_appointment` is not covered by the offline fallback.~~ A meeting outcome (complete / no-show / cancel / reschedule) is now queued in `ecofy_lead_activities` when Ecofy is unavailable and replayed by the ticker. It is stored as kind `appointment`, so no migration was needed; `payload.action` tells it apart from a booking. It only works for a meeting Ecofy already knows, because it needs Ecofy's appointment id.
   - ~~`WithdrawalTab` is fully written but not rendered.~~ The tab is now on the lead page. OpenAPI: `POST /cases/{caseId}/withdrawals` is ITARANG_CALLER + ITARANG_ADMIN, so the assigned ASM / ISR and the Sales Head can request. `confirm` / `reject` / `epc-informed` are ITARANG_ADMIN only (Sales Head). `sanction-cancelled` is ECOFY_ADMIN and is not offered. Caveat: the tab lists withdrawals with `GET /cases/{caseId}/withdrawals`, which the OpenAPI does not define (only POST). It has not been run against the sandbox. If Ecofy does not serve it, the list shows an error, but requesting still works.

   Not possible under the contract (left as is):
   - Quote request is a log entry only. OpenAPI has only `POST /cases/{caseId}/quote-requests` ("Log a quote request", body `epcPartnerId` + `channel`) and `PATCH /quote-requests/{id}`. BRD M09: "IC logs the quote request (EPC partner, channel)". No endpoint notifies the EPC.
   - Only `lead.assigned` of the §4 events is used. `lead.accepted` (`data: {}`) only "links `crmLeadId` to the case" (§3: "you can also send `lead.accepted` later"). The CRM already links on every `lead.pushed` reply (`{ crmLeadId }`, `inbound.ts`). The doc defines no "worker opened / acknowledged" trigger, so nothing was invented.
   - Ecofy audit cannot attribute actions to a person. The OpenAPI defines no act-as or actor header; its only security is the session cookie. `X-Itarang-Act-As` / `X-Itarang-Actor-Name` are defined only in `docs/ECOFY_INTEGRATION.md` §5, and Act-As must name an ACTIVE iTarang Admin/Caller *in Ecofy* (anyone else gets 403). The CRM also deliberately hides CRM identities from Ecofy (`ECOFY_OUTBOUND_ACTOR`, commit e7603546). This is unchanged and is a product decision, not a code gap.

   Still open:
   - Ecofy leads live outside `dealer_leads`, so they are absent from the main funnels, reports and AI tooling.
   - Assignment is saved in the CRM first; telling Ecofy is best-effort, with a resend path.

## Verification coverage

- `scripts/verify-ecofy-workspace.ts` makes read-only checks.
- `scripts/verify-ecofy-e2e.ts` drives S1→S6 on one sandbox lead. Nothing scripts S6→S8, intake or imports.
- Unit tests cover access, signature, stepBrief, the client, intake schemas/mapping and AssessmentCreate. There are no route or page tests.
- Not yet run against the Ecofy sandbox: `POST /cases`, the import wizard, CALCULATOR assessment save, `GET /assets/{id}`. UAT-01/02/03 (import), UAT-10/14/15 (assessment) and UAT-27/29 (asset) are the acceptance cases to run.

## Open items from `docs/ECOFY_INTEGRATION.md`

1. The doc references `docs/CONFLICTS.md` and `docs/ecofy_openapi_v1.0.1.yaml`. The OpenAPI file is now at `docs/ecofy-handoff/Ecofy_Developer_Handoff_v1.4/02_API_DATABASE/`; `CONFLICTS.md` is still missing.
2. The env names on the two sides are not mapped to each other: Ecofy uses `ITARANG_CRM_*`, the CRM uses `ECOFY_SYNC_SECRET` / `ECOFY_EVENTS_URL` / `ECOFY_API_BASE`.
3. When the secret is missing, the CRM's inbound route answers 503; the doc says 404.
4. The CRM chose a separate `ecofy_leads` table over `leads` with `source='ECOFY'`, which is why Ecofy leads are outside the CRM funnels.
5. The CRM uses the §4 events and the §5 API together; the doc says either one. `lead.accepted` is never sent; it is not needed, because the `lead.pushed` reply already links `crmLeadId` (see Remaining gaps §3).
6. Ecofy-side operations (its migrations and creating the integration user) have no CRM runbook.
