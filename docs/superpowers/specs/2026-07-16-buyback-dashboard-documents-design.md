# Buyback admin dashboard + documents redesign — design spec

Approved 2026-07-16 (user picked: money-story charts, server-side filters, formal docs only, click-through everywhere; chart selection delegated).

## Problem

1. The admin Buyback Dashboard reads as generic/AI-generated: hand-rolled CSS bars (the only chart surface in the app not on recharts), a margin chart that renders one lonely bar, filters that are client-side-only and silently skip the KPI row and funnel.
2. The Documents page requires knowing a request/RC/TXN number. An admin who only knows the dealer has no path to a document.

## Section 1 — Dashboard

### API — one consolidated endpoint (NEW)

`GET /api/admin/buyback/dashboard?from=<iso>&to=<iso>&dealer=<entityId|all>&vendor=<vendorId|all>` (requireBuybackAdmin, read-only). The existing `/api/admin/buyback/reports` route stays untouched (reports page still uses it). All blocks computed server-side under the SAME filter set, single response:

```jsonc
{
  "kpis": {
    "dealers":            { "value": 2,    "delta": 1 },      // active dealers in window; delta vs previous equal-length window
    "requests":           { "value": 25,   "delta": -3 },
    "active_negotiations":{ "value": 1,    "delta": 0 },
    "margin":             { "value": 5350, "delta": 2550 }    // ₹, locked margin of deals CLOSED in window
  },
  "money_flow": [   // monthly buckets across the window (max 12)
    { "month": "2026-07", "received": 12000, "paid_out": 9450, "margin_locked": 2550 }
  ],
  "funnel": [       // fixed 5 stages, each with queue deep-link key
    { "stage": "Submitted", "key": "submitted", "deals": 2, "units": 14, "value_at_stake": 18000 }
  ],
  "mix": {
    "chemistry": [ { "key": "LFP", "units": 40 }, { "key": "NMC", "units": 12 }, { "key": "Not specified", "units": 3 } ],
    "brand":     [ { "key": "Exide", "units": 20 }, /* top 5 */ { "key": "Other", "units": 9 } ]
  },
  "dealers": [ { "entity_id": "…", "name": "…", "deals": 2, "closed": 2, "margin": 2800, "paid_out": 9450 } ],
  "vendors": [ { "vendor_id": "…", "name": "…", "threads": 2, "won": 1, "bid_to_win": 50, "bought": 12000 } ]
}
```

Data sources (all existing, no schema change): `deal_line_locks` (margin — never live catalog), `settlement_transactions` (`txn_date`, `direction`, `leg` → received/paid_out series), `buyback_deals.status` (+`buyback_requests.created_at`) for funnel/KPIs, `buyback_lines` (`chemistry`, `brand`, `quantity`) for mix, `vendor_threads` for vendor table. Deltas = same aggregates over the previous window (`from − (to−from)` → `from`). Dealer filter = `buyback_requests.dealer_entity_id`; vendor filter = deals having a `vendor_threads` row for that vendor.

### Page — `src/app/(dashboard)/admin/buyback/dashboard/page.tsx` (rewrite of the data/chart layer, keep the shell/nav)

Charts on **recharts** (already a dependency; house pattern = CEO dashboard/intellicar), lazily loaded (`dynamic`, `ssr:false`) in a new small kit `src/components/buyback/charts/` styled with the existing buyback `Card` + `--color-bb-navy` tokens:

1. **Money flow** — `ComposedChart`, monthly: green bars "Received" (vendor receipts IN), amber bars "Paid out" (dealer payouts OUT), navy 2px `Line` "Margin locked". Shared ₹ axis, compact ₹ tick formatter (₹5k), tooltip with all three values, legend top-right. Hover-only — no month click (the queue has no month filter to deep-link to).
2. **KPI row with deltas** — same 4 KPIs, now filter-aware; each shows ▲/▼ delta vs the previous equal-length window (hero margin card keeps navy gradient). Delta hidden when previous window is empty.
3. **Pipeline funnel** — bespoke clickable rows (kept intentionally custom — reads better than a generic funnel chart): stage bar + deals + units + ₹ at stake + conversion % vs previous stage; click → `/admin/buyback/requests?stage=<key>` (queue gains a `stage` query-param filter mapped to its existing status filters).
4. **Battery mix donut** — recharts `PieChart` (donut, innerRadius) with "Chemistry | Brand" toggle chips; center label = total units; legend with per-slice units. Colors: small fixed categorical set anchored on navy/green/amber/slate.
5. **Leaderboards** — dealer + vendor tables kept, each row gains an inline margin-share micro-bar; dealer row click → Review Queue filtered to dealer; vendor row click → vendor detail page. CSV exports unchanged.

Interaction rules: any filter change re-fetches (single request, loading skeletons per card); empty windows render honest empty states ("No settlements in this window"), never a blank chart; date presets Last 30 / 90 / 180 / 365 days (default 90).

## Section 2 — Documents

### APIs (NEW, all requireBuybackAdmin, read-only)

- `GET /api/admin/buyback/documents/recent?limit=8` — latest formal documents network-wide: UNION across `vendor_threads.quotation_pdf_s3`, `purchase_orders.pdf_s3`, `invoices.pdf_s3`, `settlement_transactions.proof_s3`, `pickups.eway_bill_s3`/`weighbridge_slip_s3`; each row = { doc_type, request_id, request_no, dealer_name, ts }; ordered ts DESC.
- `GET /api/admin/buyback/documents/dealers?q=&page=` — dealer directory: accounts joined through requests→deals→doc tables; { entity_id, name, requests, docs, last_doc_at }; `q` ILIKE on `business_entity_name` (trigram-indexed); 25/page.
- `GET /api/admin/buyback/documents/dealers/[entityId]` — all of one dealer's deals, each with its full document set. The per-deal doc fan-out in `requests/[id]/documents/route.ts` is refactored into a shared lib fn `buildDealDocumentSet(dealId)` used by both routes (no behavior change to the existing route).

Formal docs only — `buyback_photos` excluded everywhere (photos stay on request detail).

### Page — `src/app/(dashboard)/admin/buyback/documents/page.tsx`

1. **Recent-docs dropdown**: focusing the existing search input with <2 chars typed opens a panel listing the 8 most recent documents (doc-type badge, request_no, dealer, relative date); clicking one selects that request (existing doc-matrix view). Typing ≥2 chars switches to the existing typeahead behavior unchanged.
2. **Dealer directory table**: below the search when no request is selected (replaces the bare "Pick a deal" empty state): Name | Requests | Documents | Last document, with its own small search box; click a dealer → dealer view.
3. **Dealer view**: header (name + totals + back), then one section per deal (request_no, status chip, date) with the existing `DocPreviewCard` grid; missing-docs banner per CLOSED deal reused.
4. Existing flows untouched: deep search by RC/TXN/request-no, per-request direction matrix, PDF links.

## Boundaries

Read-only admin GETs only; no schema/migration changes (E-185/E-192 indexes cover every query); dealer portal untouched; NO NEW TEST FILES; buyback styling tokens + Card idiom; recharts loaded lazily so dashboard bundle stays lean.

## Error handling & performance

- Dashboard endpoint returns `{}`-safe zeros for empty windows; per-block try/catch is NOT used — one query set, one transaction-less read; failures surface as the page's single error state with retry.
- Documents dealer directory paginated server-side; dealer view bounded by the dealer's own deals (indexes: `buyback_requests_dealer_created_idx`, per-table `_deal_idx`).
- Month bucketing via SQL `date_trunc('month', …)`; all money as numeric-string → client formats ₹ with the existing `inr` helper.

## Success criteria

An admin who knows only "Shakti Battery House" can reach any of their documents in two clicks. The dashboard answers "how much moved, how much did we make, what's stuck, what's in the pipe" for any window/dealer/vendor, and every number visibly responds to the filters.
