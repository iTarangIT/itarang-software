# Part 0 — Module-wise Implementation Plan

> Companion to `docs/Part0_BRD_V2.2.docx`. Read this first; jump back to the BRD for full text only when you need detail.

## Reading guide

- One **module per role** + one **shared foundation** module + one for the **AI dialer contract**.
- Each module uses the same template: Scope → Pages → Features → Workflow → Data → Checklist → Dependencies.
- Flowcharts are ASCII inside code fences. They render anywhere.
- "BRD §0.x" = the BRD section to open if you need more depth on a row.

## Roles & ownership at a glance

| Role               | Status      | What they do                                                       | Module |
|--------------------|-------------|--------------------------------------------------------------------|--------|
| `inside_sales_rep` | NEW         | Work AI-qualified leads → commercials → handoff or close           | 1      |
| `asm`              | NEW         | Receive handoff → site visit → convert/lost/escalate               | 2      |
| `admin`            | Exists      | Assign, bulk upload, resolve escalations, reports                  | 3      |
| `ceo`              | Exists      | Read-only + comment/recommend on escalations                       | 4      |
| AI dialer system   | External    | Scrape, call, score; writes `dealer_leads` + `ai_call_logs`        | 5      |
| `sales_insight`    | Already live | Read-only converted-leads dashboard (separate from Module 1)      | n/a    |

> **Naming note:** "Sales Insight" colloquially means the IS Rep workflow (Module 1) inside the team. The existing `sales_insight` role on `/sales-insight` is a separate analytics dashboard — keep the two distinct.

## Module index

| #   | Module                            | Depends on |
|-----|-----------------------------------|------------|
| 0   | Shared Foundation                 | Phase 0    |
| 1   | Inside Sales Rep                  | 0          |
| 2   | ASM (Area Sales Manager)          | 0, 1       |
| 3   | Admin / Ops Manager               | 0, 1, 2    |
| 4   | CEO                               | 0, 3       |
| 5   | AI Dialer Contract                | 0          |

---

## Module 0 — Shared Foundation

**Role:** all   **Status today:** Partial   **BRD refs:** §0.1, §0.3, §0.7, §0.12, §0.13

### Scope

- RBAC: register two new roles, gate routes.
- DB: 21 new columns on `dealer_leads` + 12 new tables.
- Lifecycle: 9-state status machine + transition validator.
- Single-owner rule: only `current_owner_id` may modify a lead.
- Touchpoint primitive: every action writes a `lead_touchpoints` row.

### Pages & Surfaces

| URL / File                       | Purpose                                    | Access  |
|----------------------------------|--------------------------------------------|---------|
| `src/middleware.ts`              | Role → dashboard map + route guards        | system  |
| `src/lib/auth-utils.ts`          | `requireAuth`, `requireRole` helpers       | system  |
| `src/components/layout/sidebar.tsx` | Per-role nav entries                    | system  |
| `src/lib/db/schema.ts`           | Drizzle table definitions                  | system  |
| `drizzle/E-XXX_*.sql`            | Hand-written, idempotent migrations        | system  |

### Key Features

- Add roles `inside_sales_rep` and `asm` everywhere a role string is checked.
- Lifecycle helper: `canTransition(from, to, ctx)` returning `{ok: boolean, reason?: string}`.
- Touchpoint writer: a single function any action calls so the audit trail is uniform.
- Concurrency check on every mutate: if row's `updated_at` changed since form-open, return 409.

### Workflow — 9-state lifecycle (BRD §0.7)

```
        +---------------+
        |New_Unassigned |
        +-------+-------+
                |  admin assigns OR rep claims
                v
   +------------+-------------+
   |Assigned_Not_Contacted    |
   +------------+-------------+
                |  first is_engaged touchpoint
                v
        +-------+--------+      <----- Awaiting_Customer_Decision (loops back)
        |Under_Discussion|
        +-------+--------+
                |
                v
   +------------+--------------+
   |Commercials_Explained      |
   +------------+--------------+
                | final_price set
                v
   +------------+--------------+
   |Commercials_Finalised      |
   +------------+--------------+
                |
        +-------+-------+
        |               |
        v               v
+---------------+ +-------+---------+
|Transferred_to_| | Converted (Mark)|
|ASM            | +-----------------+
+-------+-------+
        |   ASM converts / lost
        v
+-------+---------+        +------+
| Converted / Lost|  <---- | Lost | (terminal, from any open status)
+-----------------+        +------+
```

### Workflow — touchpoint engagement gate

```
+------------------+
| Touchpoint Saved |
+--------+---------+
         |
   is_engaged = true?
         |
   +-----+-----+
   |yes        |no
   v           v
+--+---------+ +-----------------+
|Status ->   | |Status unchanged |
|Under_      | +-----------------+
|Discussion  |
+------------+
```

### Data the module owns / writes

- `dealer_leads` — add 21 columns per BRD §0.13 (lead_status, ai_recall_status, lost_reason, previous_lost_reason, onboarding_dropout_reason, onboarding_dropout_notes, interest_level, preliminary_payment_intent, originator_id, current_owner_id, closing_owner_id, closing_role, ai_session_id, assigned_at, closed_at, last_touchpoint_at, next_follow_up_at, pre_transfer_status, asm_id, escalation_status, escalation_count, last_escalation_id, upload_batch_id, dealer_onboarding_application_id, segments JSONB, address_history JSONB, address_notes, is_active, deleted_at).
- `dealer_lead_status_history` — every status change.
- `lead_touchpoints` — every interaction (canonical 22-value enum, BRD §0.13).
- `dealer_lead_commercials` — versioned commercials (BRD §0.10).
- `lead_visits`, `lead_escalations`, `asm_territories`, `upload_batches`, `assignment_config`, `holiday_calendar`, `duplicate_merge_requests`, `interest_level_overrides`, `user_preferences` — see modules that own them.

### Implementation checklist

- [ ] Add `inside_sales_rep` + `asm` to `middleware.ts roleDashboards`, `sidebar.tsx roleNavigation`, login redirect.
- [ ] Write `drizzle/E-XXX_dealer_leads_part0_columns.sql` — additive, idempotent.
- [ ] Write `drizzle/E-XXX_lead_touchpoints.sql`, `_lead_visits.sql`, `_lead_escalations.sql`, `_dealer_lead_commercials.sql`, `_dealer_lead_status_history.sql`, `_asm_territories.sql`, `_upload_batches.sql`, `_assignment_config.sql`, `_holiday_calendar.sql`, `_duplicate_merge_requests.sql`, `_interest_level_overrides.sql`, `_user_preferences.sql` — one file per table.
- [ ] Mirror each migration in `src/lib/db/schema.ts`.
- [ ] Build `src/lib/lifecycle/transitions.ts` — transition map + hard/soft validation.
- [ ] Build `src/lib/touchpoints/write.ts` — single helper used by every mutate route.
- [ ] Working-day utility using `holiday_calendar` (BRD §0.1 Glossary).

### Dependencies (Phase 0 blockers)

- `master_locations` + `location_aliases` delivered (Anirudh).
- `dealer_leads.id` type confirmed (UUID vs Text) before any FK is written.
- AI dialer team confirms exclusion filter (Module 5).

---

## Module 1 — Inside Sales Rep

**Role:** `inside_sales_rep`   **Status today:** NEW   **BRD refs:** §0.3, §0.5, §0.7, §0.10

> Day-to-day surface for Nidhi. NOT the read-only `/sales-insight` dashboard — that one stays as-is.

### Scope

- Browse queue (own, follow-ups, unassigned).
- Claim leads from the unassigned queue.
- Log every touchpoint with engaged flag.
- Capture commercials (versioned).
- Transfer to ASM, Mark Lost, Mark Converted.

### Pages & Surfaces

| URL                                            | Purpose                                |
|------------------------------------------------|----------------------------------------|
| `/inside-sales/queue`                          | Tabs: My Open / Follow-ups Today / Unassigned / Team (read) / My Closed |
| `/inside-sales/lead/[id]`                      | 3-pane Lead Detail (history + details + action bar) |
| Modal: Log Touchpoint                          | Type, status, remarks, attachments, is_engaged |
| Modal: Update Commercials                      | event_type, prices, terms, deal_notes |
| Modal: Transfer to ASM                         | ASM picker, visit type, dealer's preferred time |
| Modal: Mark Lost / Mark Converted              | Reason picker + high-impact confirmations |

### Key Features

- Visual cues for stale leads: yellow at 5 working days no touch, red at 10, bold red at 14+.
- Hard validation: Lost needs reason; Commercials_Finalised + Mark Converted need `final_price`.
- Soft validation: skipping Commercials_Explained warns but allows.
- Follow-up carry-forward on reassignment — new owner inherits `next_follow_up_at`.
- Concurrency banner: "Lead reassigned to X — please refresh."

### Workflow — IS Rep happy path

```
+-------------+   claim / assigned   +-------------------+
| New_        | -------------------> | Assigned_Not_     |
| Unassigned  |                      | Contacted          |
+-------------+                      +-------+-----------+
                                             | first engaged touchpoint
                                             v
                                     +-------+-----------+
                                     | Under_Discussion  |
                                     +-------+-----------+
                                             |
                                             v
                                     +-------+-----------+
                                     |Commercials_       |
                                     |Explained          |
                                     +-------+-----------+
                                             | set final_price
                                             v
                                     +-------+-----------+
                                     |Commercials_       |
                                     |Finalised          |
                                     +---+----------+----+
                                         |          |
                          Transfer to ASM|          | Mark Converted
                                         v          v
                              +----------+--+   +---+--------+
                              |Transferred_ |   | Converted  |
                              |to_ASM       |   +------------+
                              +-------------+
```

### Workflow — Mark Lost (any open status)

```
+--------------+      pick reason       +------------------+
| Open status  | --------------------> | High-impact?      |
+--------------+                       +---+----------+----+
                                           |yes        |no
                                           v           v
                              +------------+--+    +---+------+
                              |Confirm modal  |    |  Save    |
                              |(consequence)  |    +----+-----+
                              +-------+-------+         |
                                      |                 |
                                      v                 |
                                  +---+----+ <----------+
                                  | Lost   |
                                  +--------+
```

### Data the module owns / writes

- `dealer_leads.lead_status`, `lost_reason`, `interest_level`, `next_follow_up_at`, `last_touchpoint_at` (trigger).
- `lead_touchpoints` — every action.
- `dealer_lead_commercials` — versioned; `is_current` flips on new event.
- `dealer_lead_status_history` — every status change.

### Implementation checklist

- [ ] Pages under `src/app/(dashboard)/inside-sales/` (queue + lead detail).
- [ ] APIs under `src/app/api/inside-sales/` (queue, lead, touchpoint, commercials, transfer, mark-lost, mark-converted).
- [ ] Reuse `requireRole(['inside_sales_rep','admin','ceo'])` for read; `requireOwner` for mutate.
- [ ] Hard-validation in transition helper (Module 0).
- [ ] Confirmation modal component for high-impact Lost reasons.
- [ ] UAT: claim → touchpoint → commercials → transfer; claim → mark lost (with high-impact).

### Dependencies

- Module 0 complete (roles, schema, lifecycle).

---

## Module 2 — ASM (Area Sales Manager)

**Role:** `asm`   **Status today:** NEW   **BRD refs:** §0.5, §0.8, §0.6

### Scope

- See own territory leads (read) + handed-off leads (own).
- Log visits with outcome + photos + GPS.
- Branch to convert / lost / escalate / next-visit from visit form.
- Mobile-first UI.

### Pages & Surfaces

| URL                                  | Purpose                             |
|--------------------------------------|-------------------------------------|
| `/asm/queue`                         | My handed-off leads + territory feed |
| `/asm/lead/[id]`                     | Mobile-first Lead Detail            |
| Modal: Log Visit                     | Status, outcome, remarks, photos, GPS, next_action |
| Auto-opened: Mark Converted / Lost / Escalate (per next_action) |

### Key Features

- Territory routing: handoff dropdown filtered by `asm_territories`; out-of-territory needs override reason.
- Visit form's `next_action` auto-opens the right follow-up form so the audit trail stays clean.
- Mobile camera upload to S3 for visit photos.
- No bounce-back: blockers go through Escalation (Module 3 owns the resolver).

### Workflow — ASM visit

```
+-----------------+   on handoff   +-----------+
|Transferred_to_  | -------------> | Schedule  |
|ASM (owner=ASM)  |                | Visit     |
+-----------------+                +-----+-----+
                                         |
                                         v
                                  +------+------+
                                  |   Visit     |
                                  +------+------+
                                         |
                  +----------------------+--------------------+
                  |          |              |                  |
            next_visit    convert         lost               escalate
                  |          |              |                  |
                  v          v              v                  v
           +------+---+ +----+------+ +-----+------+   +-------+-------+
           |Schedule  | | Mark      | | Mark Lost  |   | Escalation    |
           |another   | | Converted | | form       |   | form          |
           +----------+ +-----------+ +------------+   +---------------+
```

### Data the module owns / writes

- `lead_visits` — one row per visit (scheduled or attempted).
- `lead_touchpoints` — parallel `type='visit'` row so unified history shows visits inline.
- `dealer_leads.lead_status` on convert / lost only.

### Implementation checklist

- [ ] Pages under `src/app/(dashboard)/asm/` (queue + lead detail, mobile-first layout).
- [ ] APIs under `src/app/api/asm/` (queue, lead, visit, territory-feed).
- [ ] `asm_territories` admin CRUD (Module 3 owns the form).
- [ ] Visit `next_action` chains to existing Mark Converted / Lost / Escalate flows from Module 1 / 3.
- [ ] S3 upload component reused from existing dealer-onboarding flow.
- [ ] UAT: handoff → visit (each outcome) → next_action branches save correctly.

### Dependencies

- Module 0 + Module 1 (Mark Converted/Lost) ready.
- `master_locations` for territory lookup.

---

## Module 3 — Admin / Ops Manager

**Role:** `admin`   **Status today:** Exists (extend)   **BRD refs:** §0.4, §0.6, §0.11, §0.13

### Scope

- Assign leads from unassigned queue.
- Bulk upload from CSV (≤5MB, ≤5000 rows).
- Resolve escalations (Reassign / Return / No Action).
- Review address mismatches + merge requests.
- Resolve onboarding dropouts (Keep Converted / Flip to Lost / Re-engage).
- Run reports.

### Pages & Surfaces

| URL                                      | Purpose                                |
|------------------------------------------|----------------------------------------|
| `/admin/part0/dashboard`                 | KPI strip, team table, alert panels, filters |
| `/admin/part0/upload`                    | Bulk CSV upload + dedupe preview      |
| `/admin/part0/escalations`               | Pending escalations sorted by urgency + age |
| `/admin/part0/merge-requests`            | Phone collision + address mismatch queue |
| `/admin/part0/onboarding-dropouts`       | Loopback review                       |
| `/admin/part0/reports/*`                 | 6 pre-canned reports + filters         |
| `/admin/part0/settings`                  | `assignment_config`, `holiday_calendar`, `asm_territories` |

### Key Features

- 8 KPI tiles + "Status Changes Without Same-Hour Touchpoint" compliance tile.
- Team Performance table sorted by Critical Stale desc by default.
- 10 Alert panels (stale leads, escalations, dropouts, ASM no-activity, address mismatch, out-of-territory handoffs, etc.).
- Bulk actions desktop-only: Reassign, Mark Lost, Push to AI Dialer, Export CSV.
- "Push to AI Dialer" — context passes prior_lost_reason to AI script.

### Workflow — Bulk upload

```
+--------+   +----------+   +----------------+   +--------+
| Upload | ->| Validate | ->| AI-route       | ->| Dedupe |
| CSV    |   | each row |   | toggle (batch) |   |        |
+--------+   +----+-----+   +--------+-------+   +---+----+
                  | errors                            |
                  v                                   v
              Preview                          +------+--------+
              screen                           |  Background   |
                                               |  insert       |
                                               +-------+-------+
                                                       |
                                                       v
                                               +-------+------+
                                               | batch_id     |
                                               | rollback 24h |
                                               +--------------+
```

### Workflow — Escalation resolution

```
+----------------+     admin opens     +--------------------+
|escalation_     | ------------------> |Review thread       |
|status =        |                     |(+ CEO comment if   |
|pending_review  |                     | any)               |
+----------------+                     +---+--------+-------+
                                            |        |
                          +-----------------+        |
                          |Reassign Lead    |        |Mark No Action
                          +---+-------------+        +---+----------+
                              |                          |
                              | Return to Owner          |
                              v                          v
                       +------+----------+       +-------+--+
                       |status=resolved  |       |resolved  |
                       |new owner notif. |       +----------+
                       +-----------------+
```

### Workflow — Address mismatch resolution (5 actions)

```
+--------+    same_dealer_relocated -> update + address_history
|Pending |    data_error_reject     -> rejected_not_duplicate
|merge   | -> different_branch_*    -> note in address_notes
|request |    different_dealer_*    -> deferred (admin handles outside)
+--------+    skip_keep_existing    -> deferred
```

### Data the module owns / writes

- `upload_batches`, `duplicate_merge_requests`, `assignment_config`, `holiday_calendar`, `asm_territories`.
- Writes to `lead_escalations` (resolution fields).
- Reassign writes to `dealer_leads.current_owner_id` + a `lead_touchpoints` audit row.

### Implementation checklist

- [ ] Extend `src/app/(dashboard)/admin/` with Part 0 pages above.
- [ ] APIs under `src/app/api/admin/part0/`.
- [ ] CSV validator with location_aliases lookup + suggested-correction UI.
- [ ] Background import worker (reuse existing BullMQ pattern).
- [ ] Reports query layer — reuse existing analytics patterns where possible.
- [ ] Wire CEO read-only view to the same dashboard pages.

### Dependencies

- Module 0 + 1 + 2 done.
- Location master (Phase 0) for upload validation + territory routing.

---

## Module 4 — CEO

**Role:** `ceo`   **Status today:** Exists (extend)   **BRD refs:** §0.6, §0.12

### Scope

- Read everything Admin sees (read-only dashboard, all reports, lead detail).
- On escalations: add Comment OR submit Recommendation. Cannot resolve.
- Notified in-app for Urgent escalations.

### Pages & Surfaces

| URL                                  | Purpose                          |
|--------------------------------------|----------------------------------|
| `/admin/part0/dashboard` (read-only) | Same view, no action buttons     |
| `/ceo/escalations/[id]`              | Thread + Comment + Recommend     |
| `/admin/part0/reports/*` (read-only) | Same reports                     |

### Key Features

- Comment: free text, visible to admin in escalation thread.
- Recommend: structured ("Recommend Reassign to X" / "Recommend Return with [guidance]" / "Recommend No Action"). Admin sees it prominently.
- Explicit non-actions: no bulk operations, no settings, no lead modify, no escalation execute, no reassign.

### Workflow — CEO advisory

```
+-------------+    +---------------+    +-------------+
|Urgent       | -->|Read thread    | -->|Comment OR   |
|escalation   |    |+ admin notes  |    |Recommend    |
|notification |    +---------------+    +------+------+
+-------------+                                 |
                                                v
                                        +-------+-------+
                                        |Admin executes |
                                        |(may follow    |
                                        |recommendation)|
                                        +---------------+
```

### Data the module owns / writes

- `lead_escalations.ceo_comment`, `ceo_recommendation`, `ceo_recommended_at`.
- `lead_touchpoints` — `escalation_ceo_comment` / `escalation_ceo_recommendation` audit rows.

### Implementation checklist

- [ ] Reuse admin dashboard pages with `readOnly={true}` mode.
- [ ] CEO escalation view under `src/app/(dashboard)/ceo/escalations/`.
- [ ] API: `POST /api/ceo/escalations/[id]/comment` + `.../recommend`.
- [ ] RBAC: explicit denies on every admin mutate route for `ceo`.
- [ ] UAT: CEO logs in → opens urgent escalation → comments → admin sees it → admin resolves.

### Dependencies

- Module 3 dashboard + escalation pages exist.

---

## Module 5 — AI Dialer Contract

**Role:** external system   **Status today:** Pre-existing (extend)   **BRD refs:** §0.2, §0.9

### Scope

- Inbound: per-lead data the AI dialer writes (Section 0.2 contract).
- Hard exclusion: AI dialer MUST NOT call phones in any non-terminal sales state.
- Admin "Push to AI Dialer": re-engagement of Lost leads with prior context.
- Reactivation: AI re-engagement of a Lost lead crossing intent threshold.

### Pages & Surfaces

| URL / Surface                        | Purpose                                |
|--------------------------------------|----------------------------------------|
| Existing `src/app/api/ai-dialer/*`   | Already in place; extend to honour exclusion |
| Admin action button "Push to AI Dialer" | Bulk re-engagement (Lost only)     |

### Key Features

- AI dialer default pool query becomes: `lead_status IS NULL OR (lead_status = 'Lost' AND admin_pushed)`.
- On admin push: lead goes to AI re-engagement queue with `previous_lost_reason` context.
- If AI re-score crosses threshold: reuses existing `dealer_leads` row (phone is UNIQUE forever).

### Workflow — AI dialer pool eligibility

```
+--------+    +----------+    +---------+
|phone   | -> |lead_     | -> | NULL?   | -- yes --> AI may call
+--------+    |status?   |    +---------+
              +----+-----+         | no
                                   v
                            +------+-------+
                            |== 'Lost' AND |
                            |admin_pushed? | -- yes --> AI may call
                            +------+-------+
                                   | no
                                   v
                            +------+-------+
                            |Excluded      |
                            +--------------+
```

### Workflow — Reactivation (BRD §0.9)

```
+----------+   AI re-engages OR upload   +---------+   intent >=   +---------------+
|Lost lead | --------------------------> |AI calls | -- threshold-> |status ->     |
+----------+        OR admin manual      +---------+                |Assigned_Not_ |
                                                                    |Contacted     |
                                                                    +------+-------+
                                                                           |
                                                       previous_lost_reason saved
                                                       reactivation banner shows
                                                       new owner must engage
```

### Data the module owns / writes

- `dealer_leads.ai_recall_status`, `final_intent_score`, `ai_session_id`.
- `ai_call_logs` (existing).
- On reactivation: flips `lead_status` to `Assigned_Not_Contacted`, fills `previous_lost_reason`, clears `closed_at` / `closing_owner_id` / `closing_role`.
- `lead_touchpoints` — `reactivated_via_*` / `ai_dialer_admin_push` audit rows.

### Implementation checklist

- [ ] Confirm exclusion filter with AI dialer team (Phase 0).
- [ ] Admin UI "Push to AI Dialer" — multi-select on Lost leads + mandatory reason.
- [ ] Reactivation handler — single function called by AI promotion, upload match, admin manual.
- [ ] Reactivation banner component on Lead Detail.

### Dependencies

- Module 0 (new dealer_leads columns + lead_touchpoints).
- AI dialer team alignment.
