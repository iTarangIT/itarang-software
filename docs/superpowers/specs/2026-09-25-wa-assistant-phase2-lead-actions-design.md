# WA Assistant Phase 2 — lead actions (transfer, reassign, escalate, convert, create)

Date: 2026-09-25 · Status: design approved in chat, awaiting spec review

## Why

An ISR asked the WhatsApp assistant to transfer a lead to an ASM and got
"Main leads ko transfer nahi kar sakta… CRM se transfer kar sakte hain". That is
by design today: `src/lib/assistant/prompt.ts:74` forbids convert / transfer /
reassign / create, and no such tool exists. The goal is for the assistant to do
the lead actions an ISR and an ASM can do on the CRM lead screen.

## Scope

In: transfer to ASM, reassign, escalate, mark converted, create lead, and the
dealer WhatsApp onboarding invite (offered only after a conversion).

Out (Phase 3): update commercials, quote draft / send. Their approval flow does
not map onto one Confirm tap. Also out: undoing a conversion, notifications that
the CRM does not send today (transfer / reassign notify nobody; unchanged).

## Invariants kept (unchanged from Phase 1)

- Propose → server-built preview → only a Confirm **button tap** writes
  (`executor.ts`). A typed "yes" never writes. One write per turn.
- Pilot allow-list `ASSISTANT_WRITES_ENABLED_USER_IDS` gates every write tool.
- The acting user comes from the verified binding, never from model arguments.
- Executor re-checks ownership (`assertOwner`) and staleness (`assertNotStale`)
  inside the transaction at Confirm time.
- Out-of-scope leads are indistinguishable from nonexistent ones.

## 1. Shared services (one implementation per action)

The route logic moves into `src/lib/leads/` (or `src/lib/inside-sales/`), each
accepting an optional `{ tx }`. Routes keep `requireRole` + body parsing and call
the service. The assistant's appliers call the same service with the executor's tx.

| Service | Extracted from | CRM behaviour change |
|---|---|---|
| `transferLeadToAsm` | `api/inside-sales/lead/[id]/transfer-asm` | owner/asm_id update, `lead_visits` insert and the `asm_transfer` touchpoint + status history now commit in ONE transaction (today the touchpoint is written after, outside it) |
| `reassignLead` | `.../reassign` | owner update + `ownership_transfer` touchpoint in one transaction; target must exist and be active; not self |
| `escalateLead` | `.../escalate` | none; returns the escalation id and a post-commit notify step |
| `markLeadConverted` | `.../mark-converted` | none; the route still wraps it in `withLeadActor`, the service takes the tx; returns application id and a post-commit notify step |
| `createInsideSalesLead` | `api/inside-sales/lead/create` | none; duplicate-phone check, ISR → `New_Unassigned` no owner, ASM/partner → self-owned, `business_type` best-effort, `recordLeadCapture` |
| `listAsmOptions` | `api/inside-sales/asm-options` | none |

Notifications keep firing **after** commit and best-effort, exactly as today.

## 2. Executor changes (`src/lib/assistant/executor.ts`, `applierSpec.ts`)

1. **Post-commit effects.** `apply` may return `afterCommit: () => Promise<void>`;
   the executor runs it after the transaction commits, catches and logs errors,
   never changes the outcome.
2. **Lead-less actions.** `ownership: "none"` for `create_lead`: no row lock, no
   `assertOwner`, no staleness check (`lead_id` is already nullable in E-309).
   The applier re-checks the phone for duplicates inside the tx; the unique
   index is the final guard. `RejectReason` gains `duplicate_phone`.
3. `invite_dealer_onboarding` uses `ownership: "owner"` on the converted lead.

No migration: `assistant_actions.tool` is `varchar(40)` without a CHECK list.

## 3. Tools

Role map (`registry.ts`):

| Tool | ISR | ASM |
|---|---|---|
| `transfer_to_asm` | ✓ | — (CRM route excludes ASM) |
| `reassign_lead` | ✓ | ✓ |
| `escalate_lead` | ✓ | ✓ |
| `mark_converted` | ✓ | ✓ |
| `create_lead` | ✓ | ✓ |
| `invite_dealer_onboarding` | ✓ | ✓ |

All are write tools (listed only when writes are enabled). Every lead-bound one
starts with `ownedLeadOr`.

**transfer_to_asm** — input: `lead_id`, `asm` (name or id), `reason`
(`Commercials_Finalised | Site_Visit_Needed | Negotiation_Beyond_IS_Authority |
Demo_Requested | Other`), `visit_type` (`Initial_Visit | Demo | Negotiation |
Closing`), optional `suggested_visit_date` (resolved in IST), `dealer_preferred_time`,
`handoff_notes`, `pending_items[] (≤10)`, `out_of_territory_reason`.
ASM resolution: `listAsmOptions(lead.state, lead.city, includeOutOfTerritory)`,
in-territory first, fuzzy name match. >1 match → `question` listing names.
Out-of-territory ASM without a reason → `question`. Preview: ASM name + territory
tag, `status → Transferred to ASM`, reason, visit type/date, notes, warning
"After this the lead is the ASM's; it becomes read-only for you."

**reassign_lead** — input: `lead_id`, `to` (name), `reason` (≥20 chars; shorter →
`question`, never padded). Candidates: active users with role `inside_sales_rep`
or `asm`, excluding the actor (deliberately narrower than the route, which takes
any active user id; the CRM screen has no picker). Preview: `Owner: you → Name
(role)`, reason, read-only warning.

**escalate_lead** — input: `lead_id`, `reason` (role-specific list, same as
`EscalateModal`: ISR `Commercial_Decision_Needed | Customer_Complaint |
Compliance_Concern | Internal_Dispute | Other`; ASM `Not_Ready_for_Visit |
Dealer_Stalling | Territory_Mismatch | Customer_Complaint | Internal_Dispute |
Compliance_Concern | Other`), `notes` (≥30), `urgency` (`normal|high|urgent`),
optional `suggested_action`. Non-open status → `declined`. Preview lists who is
notified (admin, sales head, partner; + CEO when urgent).

**mark_converted** — input: `lead_id`, `gstin` (normalised + `isValidGstin`;
invalid → `question`), optional `notes`. Already Converted → `declined`.
Preview: `status → Converted`, GSTIN, "creates the dealer onboarding
application", warning "Undoing a conversion is done on the CRM screen."
The confirmed reply carries a **Send onboarding invite** button.

**invite_dealer_onboarding** — input: `lead_id`. Requires an onboarding
application on the lead and a valid WhatsApp phone, else `declined`. Preview:
dealer name + number, "sends the dealer a WhatsApp message". Applier calls
`inviteDealerToApplication` in `afterCommit` (an external send cannot roll back);
the tx only records the action. A failed send is reported in the reply.

**create_lead** — input: `dealer_name`, `phone` (10 digits), optional `shop_name`,
`city`, `state`, `interest_level`, `language`, `business_type`. Existing phone →
`declined` ("a lead with this number already exists"; lead shown only if in the
user's scope). Preview states the landing: ISR → unassigned claim pool; ASM →
owned by you.

## 4. Prompt and channel

- `prompt.ts` rule 6 becomes: commercials / quotes, undoing a conversion, and
  deleting leads stay on the CRM — say so and share the link.
- The WhatsApp renderer handles the new `question` candidate lists (existing
  list-message path) and the post-convert invite button (a reply button whose tap
  asks the agent to propose `invite_dealer_onboarding` for that lead).
- The confirmed-reply text for transfer/reassign names the new owner.

## 5. Testing

- Vitest (pure, no I/O) in `src/lib/assistant/__tests__/`: schemas, preview
  builders, ASM/user name matching, GSTIN/phone/length refusals, registry role map.
- `scripts/verify-wa-phase2-services.ts`: each shared service against sandbox
  inside a transaction that is rolled back (read-only net effect).
- Existing Playwright workflow suite for CRM transfer / convert regressions.
- Manual pilot pass on sandbox WhatsApp: each tool, a stale-preview refusal, and
  the invite button.

## Risks

- Refactoring live routes: mitigated by keeping route bodies/responses
  byte-identical and the regression suite.
- Transfer/reassign strip the actor's ownership — the confirm tap is the guard;
  the preview says so.
- Name matching picks the wrong person — always shown by full name + role in
  the preview, and ambiguous matches ask instead of guessing.
