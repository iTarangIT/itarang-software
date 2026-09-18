# Pile B — Review items #4 (Sales Dashboard) and #8 (WhatsApp Operator Console)

_Reviewed 2026-09-17 against branch `Rushikesh-claude`._

## #4 Sales Dashboard — What exists today vs what to build

Every role dashboard reads `GET /api/dashboard/[role]` (`src/app/api/dashboard/[role]/route.ts`).

| Dashboard | Widget | Today | Source / note | What to build |
|---|---|---|---|---|
| **Sales Head** `/sales-head` | Monthly Sales Target | ❌ Hardcoded `₹4.5 Cr` | — | Target table/config + actual from `orders` |
| | Pipeline Revenue | ❌ Hardcoded `₹12.8 Cr` | API already returns `pipelineRevenue` (sum `deals.total_payable`, open deals), **not rendered** | Wire the API value |
| | Team LVR / Expansion Regions | ❌ Hardcoded `3.2x` / `6` | — | Define the formula; regions = distinct `dealer_leads.state` with activity |
| | Regional Performance chart | ❌ Static data | — | Group `dealer_leads` / orders by state |
| | Lead Sources | ❌ Static (Ground 45%, OEM 30%…) | `dealer_leads.source` exists | GROUP BY source |
| | Pipeline Velocity / Top Managers | ❌ Static | CEO dashboard already computes top managers (`lead_assignments` + `users`) | Reuse the CEO query |
| | Total Revenue | ⚠ API returns `totalRevenue` (sum `orders.total_amount`), not shown | | Render it |
| **Sales Manager** `/sales-manager` | Active Leads | ✅ Real | `dealer_leads` ⨝ `lead_assignments` | — |
| | Pipeline Value / Hot Leads | ❌ Always 0 — the API never returns `pipelineValue` / `hotLeads` | | Add to API (deals sum; `intent_band='hot'`) |
| | Conversion Rate | ❌ Hardcoded `14.2%` | | Qualified ÷ assigned, same window |
| | "vs last week" deltas | ❌ Hardcoded on every card | | Previous-period comparison |
| | Deal Status Distribution | ❌ Static | | GROUP BY deal status |
| | Pending KYC Reviews | ✅ Real (`/api/sm/leads`) | | — |
| **Sales Executive** `/sales-executive` | Assigned / Hot / Conversions / Open Tasks | ❌ Fully static server component (24 / 8 / 5 / 12) | API branch `sales_executive` exists but isn't called | Convert to client + call the API; add hot / conversions / tasks |
| **Business Head** `/business-head` | Lead Conversion (MTD) | ⚠ Real but **all-time**, labelled MTD | `current_status='qualified'` | Apply the month window |
| | Active Leads | ✅ Real | | — |
| | Avg Qualification Time | ❌ Fallback `1.8 Days` | | From `dealer_lead_status_history` |
| | Lead Progress / Category / L2 Queue / Top Actors | ❌ Placeholder | | Build per spec |
| **Admin Reports hub** `/admin/reports` | 8 reports: daily activity, funnel, lost analysis, AI score accuracy, source performance, ASM handoff, meetings MTD, funnel by owner | ✅ Live, with CSV | `src/lib/admin/reports.ts` | — |
| **CRM Reporting Spec v2.1** (status ageing, stage TAT, unassigned analysis, campaign, dialer coverage, 4 conversion measures) | ❌ Not in code — only in `git stash@{0}` (E-294, reverted) | Partial foundations are live: `dealer_lead_status_history` (E-117), `lead_touchpoints.from/to_owner_id` (E-295) | Restore / rebuild from the stash if the team approves |

**Summary.** Sales Manager and Business Head have 1–2 real numbers each. Sales Head and Sales Executive are mostly mock-ups, even though the API already computes some of their values. The quickest win is wiring the existing API fields (`pipelineRevenue`, `totalRevenue`, sales-executive `activeLeads`) and removing the hardcoded deltas. Everything else needs a definition from the business (targets, LVR, velocity).

## #8 WhatsApp Operator Console — already built ✅

No new development needed. Built under E-214 (+ E-279):

- **Admin page** `/admin/whatsapp-onboarding` (roles admin, sales_head, ceo, partner). Tabs:
  1. **Live conversations** — every onboarding chat from the first message, transcript + prospect drawer.
  2. **Customer leads** — leads a dealer started on WhatsApp but didn't submit.
  3. **Onboarding team** — operator allowlist (add / activate / deactivate / rename), per-operator dealer pipeline, resend credentials / invite, transcript viewer (passwords stripped).
  4. **Multiple dealer** — extra main-dealer numbers per dealership (E-279).
- **Chat side** — `src/lib/whatsapp/operator-orchestrator.ts`: one internal operator onboards many dealers from one number (hub session + one file session per dealer). `operator-handoff.ts` hands a file over to the dealer's own number. `operator-identity.ts` gates operators by phone.
- **APIs** — `api/admin/whatsapp-operators` (+ `[operatorId]`, `/pipeline`, `applications/[id]/resend-*`, `sessions/[sessionId]/messages`), `api/admin/whatsapp-onboarding/conversations`, `customer-leads`, `api/admin/dealer-extra-numbers`.

Recommendation: smoke-test on sandbox (add an operator number → onboard a test dealer → hand off) and close the item.
