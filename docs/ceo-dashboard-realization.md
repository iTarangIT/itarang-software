# CEO dashboard — Realization, Green KM & Responsible Recycling (E-219)

Replaces the five-card KPI row and the "Revenue Performance Trend" chart on
`/ceo`. Agreed with Kartik on 2026-07-29; this file records the definitions, so
a number can be checked against what was actually asked for.

## What is on the page

| Card | Value | Source |
|---|---|---|
| **Realization** (clickable) | Revenue − Expense | `zoho_invoices`, `expense_submissions` |
| **Leads** | leads created in window, qualified as subtitle | `dealer_leads` |
| **Green KM Covered** | fleet distance in window | IoT `distance_rollup` |
| **Responsible Recycling** | requests submitted / completed | `buyback_requests`, `buyback_deals` |

Below them, **Revenue, Expense & Realization** — revenue and expense as bars,
realization as a line tracing the gap, all on one ₹ axis.

Deliberately **not** built: a Sales card and the CEO Leads report. See
"Deferred" below.

## Definitions

Every figure resolves through `resolveWindowParams()` in
`src/lib/dashboard/salesWindow.ts`, so the cards, the drill-down and the chart
cannot describe different spans.

- **Revenue** — `SUM(zoho_invoices.total)` where `invoice_date` is in the
  window and status is not `void`. Drafts count, per the existing Revenue card.
- **Expense** — `SUM(expense_submissions.amount)` where `status = 'approved'`
  and the **effective date** is in the window. Effective date is
  `COALESCE(expense_date, approved_at::date)` (E-216) — the date on the bill,
  not the date somebody scanned it. This is what makes Realization reconcile to
  the rupee with `/ceo/expenses`.
- **Realization** — Revenue − Expense. Nothing else.
- **Outstanding** — unpaid balances on invoices **raised in the window**. Shown
  inside the drill-down as context, and explicitly *not* a term in the formula:
  it is revenue already counted that has not been collected. Note this differs
  from the standalone Outstanding Credits drill-down, which is an all-time
  snapshot.
- **Buyback** — total counts requests with `submitted_at IS NOT NULL`, so
  abandoned drafts do not inflate it. Completed counts deals at `SETTLED` or
  `CLOSED`.
- **Green KM** — `SUM(distance_km)` over `distance_rollup` where
  `bucket_size = 'day'`.

### Windows

`mtd` · `ytd` (1 Jan → today) · `fy` (1 Apr → today) · `inception` (no lower
bound) · a custom `from`/`to` day range with an inclusive `to`. A malformed
range is a 400, never a silent fall back to the current month.

Chart bucket size follows the span — month-to-date is daily, the long periods
are monthly, a custom range switches at 62 days — with the
Daily/Weekly/Monthly toggle as an override.

## Two things that will look like bugs and are not

**1. Responsible Recycling reads "not present in this environment" on prod.**
`E-185_buyback_core` is applied on db-1 and sandbox but **not on production** —
see `drizzle/MIGRATION_CHECKLIST.md`, where both prod columns are unticked
(remember db-2 *is* prod). Querying `buyback_requests` there raises `42P01`.
`/api/dashboard/ceo/overview` catches exactly that code and reports the card
unavailable; every other error still propagates. Applying E-185 to production
turns the card on with no code change.

**2. Green KM says "rollups stale since ‹date›" or "telemetry unreachable".**
`distance_rollup` is written by an aggregator in the `iot_stack` repo. Its
sibling job never ran — `trips` has never held a row — so a rollup that quietly
stopped is a live possibility, and after the Hostinger→AWS move the aggregator
was not redeployed. The card reports the newest bucket's age rather than
presenting a frozen total as current. "Unreachable" almost always means the IoT
SSH tunnel is down, the same cause as the banner on `/ceo/intellicar`.

Neither state renders as `0`. Zero km across a driving fleet, or zero recycling
requests in a month, is a claim — and a false one.

## The Expenses drill-down

E-218 put four clickable bucket tiles, a six-month stacked bar chart and a
department strip above the invoice list. The tiles and the chart are gone.

- **Filter row** — Department, Bucket, Month and an explicit date range. Each
  dropdown option is labelled with the invoice count it would leave in the list
  (`Tech (147)`), so the cost of a filter is visible before applying it. Counts
  come from a `COUNT(*)` in `expenses-buckets`, *not* from the fetched rows —
  those stop at `ROW_CAP` (500) and would undercount silently.
- Every filter is applied **server-side**, for the same reason.
- A Month or a date range picked here **replaces** the window inherited from the
  page filter bar rather than intersecting with it. Both say "which days this is
  about", so the more specific one wins outright; intersecting would return an
  empty list whenever the two disagreed.
- The breakdown follows the window but **not** the department/bucket filters.
  Otherwise picking a department would leave it as the only bar on the strip and
  collapse every dropdown count to the one already chosen.
- The **By department** bars stay, and each is now also a shortcut for the
  Department dropdown — the bars are where you notice a department, so they are
  where you would try to click.
- `expenses-buckets` no longer returns `trend`. Its only consumer was the
  deleted chart, and it cost an extra grouped scan on every open.

## Pagination

Four lists page at 25 rows (the two recent lists at 5, with a compact control):
the drill-down table, the Expense Ledger, Recent Invoices and Recent Expenses.
All share `src/components/shared/Pagination.tsx`.

Paging is **client-side**, over rows already fetched — every one of these lists
is server-capped well below the point where that matters. It is not a substitute
for a LIMIT/OFFSET API; if a list ever needs more rows than its cap, the cap is
what to fix.

Two properties the control is built around:

- **Totals never page.** The drill-down's `Total:` and the ledger's footer cover
  every matching row, not the page on screen — a per-page subtotal on a
  financial list invites reading it as the total.
- **The full count is always stated** ("Showing 26–50 of 213 records"), because
  the whole hazard of paging a financial list is mistaking page one for the lot.

Filtering resets to page one and `usePagination` clamps the page when a filter
shrinks the list under it — otherwise sitting on page 5 of a freshly-filtered
two-page list shows an empty table with no indication why.

## Layout

`/api/dashboard/ceo/overview` serves the three CRM-sourced cards and the chart.
Green KM has its own route because it is the only figure from the IoT Postgres,
which is reached over a tunnel with an 8-second connect timeout: folded into the
overview handler, one dead tunnel would stall every card and then fail them all.

`/api/dashboard/[role]` no longer computes `revenueTrend` — the chart that read
it is gone. Everything else it returns still feeds the Business Snapshot panel.

## Deferred

- **Sales card (units sold).** Not built: `zoho_invoices` stores no line items.
  `sync.ts` pulls Zoho's *list* endpoint, which omits `line_items`, so even
  `raw_json` has no quantities, and fetching them live would be one API call per
  invoice per page load. A real units card needs a `zoho_invoice_line_items`
  table, a sync change and a backfill.
- **CEO Leads report** (by sales manager / city, fresh vs repeat, calling /
  ground meeting / WhatsApp). The raw material exists in `lead_touchpoints` and
  `lead_visits`.
