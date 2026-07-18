# Buyback Dashboard + Documents Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-rolled admin buyback dashboard with a filter-aware, click-through recharts dashboard fed by one consolidated API, and make the Documents page navigable by dealer (recent-docs dropdown + dealer directory + per-dealer doc view).

**Architecture:** One new read-only dashboard endpoint computes every block (KPIs+deltas, monthly money flow, funnel, battery mix, leaderboards) server-side under a shared filter set; the page becomes a thin recharts renderer over it. Documents gains three read-only endpoints (recent, dealer directory, dealer doc view) sharing a `buildDealDocumentSet` lib function refactored out of the existing per-request documents route.

**Tech Stack:** Next.js 16 App Router route handlers, Drizzle/raw SQL over existing tables (no schema change), recharts ^3.6.0 (already a dependency) loaded via `next/dynamic` `ssr:false`, buyback atom kit (`src/components/buyback/ui`) + `--color-bb-navy` tokens.

**Spec:** `docs/superpowers/specs/2026-07-16-buyback-dashboard-documents-design.md` (approved 2026-07-16).

## Global Constraints

- **NO NEW TEST FILES** (house rule; suite baseline 1595 passed | 1 failed pre-existing charging-export | 3 skipped). Verification = `npx vitest run` baseline-identical, `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` (exactly 9 pre-existing E-101 errors), `npx eslint <touched files>` clean on added lines, plus live curl smoke at the final gate.
- All new routes `requireBuybackAdmin` (same helper the existing buyback admin routes import), read-only GET, wrapped in the same `withErrorHandler` / response envelope as sibling routes (`{success, data}` — copy the exact envelope from `src/app/api/admin/buyback/reports/route.ts`).
- No schema/DDL changes. No `db:push`. All queries must be servable by existing indexes (E-185 `buyback_requests_dealer_created_idx`, per-doc-table `_deal_idx`, E-192 trigram on `accounts.business_entity_name`).
- Margin math sources ONLY `deal_line_locks` (never live catalog prices) — mirror the `lockedCte` in `src/app/api/admin/buyback/reports/route.ts:93-122`.
- Dealer-portal routes/components untouched. No dealer figures leak into any new surface (all surfaces here are admin-only).
- Styling: buyback `Card` (`src/components/buyback/ui/Card.tsx`), existing KPI hero gradient, stock Tailwind slate/green/amber + `--color-bb-navy #0B2239`. Charts must be dynamically imported (`ssr:false`) so the dashboard route stays SSR-safe (recharts is client-only) — copy the pattern from `src/components/shared/charts.tsx`.
- Money values travel as numeric strings/numbers in JSON; the UI formats with the page's existing `inr` helper.
- Git: explicit paths only (never `git add -A`; never stage `scripts/polar-aggregator-review.mjs` or `bash.exe.stackdump`). Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; use `git commit -F <file>` if `-m` hangs.
- One heavy node process at a time (vitest OR tsc, never both).

---

### Task V1: Stage buckets shared in flow.ts

**Files:**
- Modify: `src/lib/buyback/flow.ts` (add exports at bottom)
- Modify: `src/app/(dashboard)/admin/buyback/dashboard/page.tsx:145-159` (delete the local bucket map in V4 — noted here so the shape matches)

**Interfaces:**
- Produces: `STAGE_BUCKETS: ReadonlyArray<{ key: string; label: string; statuses: readonly string[] }>` — the five funnel stages in pipeline order, each listing the exact `buyback_deals.status` values it contains. Also `stageForStatus(status: string): string | null` returning the bucket key.

- [ ] **Step 1: Read the current bucket map** at `src/app/(dashboard)/admin/buyback/dashboard/page.tsx:145-159` — it already buckets all 21 statuses into 5 stages (Submitted / Reviewed / Locked / Picked / Settled). Copy those exact status lists; do NOT invent new groupings.

- [ ] **Step 2: Add to `src/lib/buyback/flow.ts`:**

```ts
/** The dashboard funnel's five pipeline stages, in order. Buckets every
 *  buyback_deals.status; used by the dashboard API (SQL IN lists), the
 *  dashboard funnel UI, and the Review Queue's ?stage= deep-link filter. */
export const STAGE_BUCKETS = [
  { key: "submitted", label: "Submitted", statuses: [/* exact lists from page.tsx:145-159 */] },
  { key: "reviewed",  label: "Reviewed",  statuses: [/* … */] },
  { key: "locked",    label: "Locked",    statuses: [/* … */] },
  { key: "picked",    label: "Picked",    statuses: [/* … */] },
  { key: "settled",   label: "Settled",   statuses: [/* … */] },
] as const;

export function stageForStatus(status: string): string | null {
  for (const b of STAGE_BUCKETS) if ((b.statuses as readonly string[]).includes(status)) return b.key;
  return null;
}
```

- [ ] **Step 3: Verify** — `npx eslint src/lib/buyback/flow.ts` clean; `tsc` deferred to batch gate.

- [ ] **Step 4: Commit** (may be folded into the batch commit): `feat(buyback): share funnel stage buckets in flow.ts`

---

### Task V2: Consolidated dashboard API

**Files:**
- Create: `src/app/api/admin/buyback/dashboard/route.ts`

**Interfaces:**
- Consumes: `STAGE_BUCKETS` from `src/lib/buyback/flow.ts` (Task V1); `requireBuybackAdmin`, response envelope, and the `lockedCte` SQL pattern from `src/app/api/admin/buyback/reports/route.ts`.
- Produces: `GET /api/admin/buyback/dashboard?from&to&dealer&vendor` returning `{ success: true, data: DashboardPayload }` where `DashboardPayload` is exactly the spec's JSON shape: `kpis.{dealers,requests,active_negotiations,margin}` each `{value: number, delta: number|null}`; `money_flow: {month: 'YYYY-MM', received: number, paid_out: number, margin_locked: number}[]`; `funnel: {stage: string, key: string, deals: number, units: number, value_at_stake: number}[]` (all five stages always present, zeros included, in STAGE_BUCKETS order); `mix: {chemistry: {key,units}[], brand: {key,units}[]}` (brand = top 5 + "Other", chemistry nulls → "Not specified"); `dealers: {entity_id,name,deals,closed,margin,paid_out}[]` (top 20 by margin); `vendors: {vendor_id,name,threads,won,bid_to_win,bought}[]` (top 20).

- [ ] **Step 1: Read the authoritative sources** — `src/app/api/admin/buyback/reports/route.ts` end-to-end (lockedCte :93-122, funnel :161-181, dealer :204-223, vendor :225-271, window handling :287-289) and `.../ledger/route.ts:138-172` (expected-margin). The new route re-implements these aggregations under ONE filter set; copy join/column names verbatim from there, never guess.

- [ ] **Step 2: Implement the route.** Skeleton (exact params/validation; SQL bodies adapted from reports route):

```ts
import { NextRequest } from "next/server";
// same imports/helpers as reports/route.ts: db, sql, requireBuybackAdmin, envelope helpers
import { STAGE_BUCKETS } from "@/lib/buyback/flow";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // 1. requireBuybackAdmin — identical call to reports route.
  // 2. Params: from/to ISO dates (default: to=now, from=now-90d; clamp span ≤ 400d),
  //    dealer = accounts.id uuid or "all", vendor = scrap_vendors.id uuid or "all".
  //    Invalid uuid/date → 400 via the shared envelope.
  // 3. Window pair: current [from,to) and previous [from-(to-from), from) for deltas.
  // 4. Shared filter fragments applied to EVERY block:
  //    dealerFilter: buyback_requests.dealer_entity_id = $dealer
  //    vendorFilter: EXISTS (SELECT 1 FROM vendor_threads vt WHERE vt.deal_id = d.id AND vt.vendor_id = $vendor)
  //    windowFilter per block: requests/deals by buyback_requests.created_at;
  //    money_flow by settlement_transactions.txn_date; mix by buyback_lines join through the window's deals.
  // 5. Blocks (each ONE grouped query, no N+1):
  //    kpis: dealers = COUNT(DISTINCT dealer_entity_id); requests = COUNT(deals);
  //          active_negotiations = COUNT(deals WHERE status IN (NEGOTIATING, FINAL_OFFER_SENT, VENDOR_ROUTED, VENDOR_NEGOTIATING));
  //          margin = Σ qty×(vendor_price−dealer_price) over deals CLOSED in window (lockedCte).
  //          Each also computed for the previous window → delta = current − previous;
  //          delta = null when the previous window has zero activity for that metric.
  //    money_flow: date_trunc('month', txn_date) buckets; received = Σ amount WHERE direction='IN';
  //          paid_out = Σ amount WHERE direction='OUT'; margin_locked = lockedCte margin of deals
  //          whose locked_at falls in that month. Emit every month in the window (gaps as zeros).
  //    funnel: reports :161-181 GROUP BY status, then fold statuses into STAGE_BUCKETS server-side;
  //          always emit all 5 stages in order.
  //    mix: JOIN buyback_lines through the window's requests; chemistry: GROUP BY COALESCE(chemistry,'Not specified');
  //          brand: GROUP BY brand top 5 by Σ quantity, rest summed as 'Other', NULL brand → 'Not specified'.
  //    dealers/vendors: reports :204-223 / :225-271 with the shared filters, LIMIT 20.
  // 6. Return the envelope with all blocks.
}
```

- [ ] **Step 3: Live-verify with curl** (dev server, admin session cookie — the SDD controller smoke pattern): default window returns all blocks with the documented shape; `?dealer=<real id>` visibly changes kpis + money_flow + funnel; empty window (from/to in 2020) returns zero-filled blocks with all 5 funnel stages, HTTP 200.

- [ ] **Step 4: Gates** — vitest baseline-identical; tsc 9 pre-existing only; eslint clean on the new file.

- [ ] **Step 5: Commit:** `feat(buyback): consolidated admin dashboard API — filtered KPIs, money flow, funnel, mix`

---

### Task V3: Buyback charts kit

**Files:**
- Create: `src/components/buyback/charts/MoneyFlowChart.tsx`
- Create: `src/components/buyback/charts/MixDonut.tsx`
- Create: `src/components/buyback/charts/index.tsx` (dynamic `ssr:false` exports)

**Interfaces:**
- Consumes: recharts (direct imports inside the two chart files only); `inr`-style formatting passed in as props (no buyback lib imports here — pure presentational).
- Produces:
  - `MoneyFlowChart({ data, height? }: { data: { month: string; received: number; paid_out: number; margin_locked: number }[]; height?: number })`
  - `MixDonut({ data, centerLabel, height? }: { data: { key: string; units: number }[]; centerLabel: string; height?: number })`
  - `index.tsx` re-exports both via `next/dynamic` with `ssr:false` and a skeleton `loading` element — page code imports ONLY from `@/components/buyback/charts`.

- [ ] **Step 1: Read the house chart patterns** — `src/components/shared/charts.tsx` (+`charts-impl.tsx`) for the dynamic-import wrapper, and `src/components/intellicar/battery/charts/chart-kit.tsx` for tooltip/legend composition style. Match idiom, don't import from intellicar.

- [ ] **Step 2: `MoneyFlowChart.tsx`** — `ComposedChart` (recharts): `<Bar dataKey="received" name="Received" fill="#16A34A" radius={[3,3,0,0]} />`, `<Bar dataKey="paid_out" name="Paid out" fill="#F59E0B" radius={[3,3,0,0]} />`, `<Line dataKey="margin_locked" name="Margin locked" stroke="#0B2239" strokeWidth={2} dot={{r:3}} />`; X = month formatted `Jul '26`; Y compact ₹ ticks (`₹5k`, `₹1.2L` — lakh above 1e5); tooltip listing all three ₹-formatted; `<Legend />` top; `ResponsiveContainer` height default 260. Empty `data` → render nothing (parent owns the empty state).

- [ ] **Step 3: `MixDonut.tsx`** — `PieChart` + `Pie` `innerRadius={55} outerRadius={85} paddingAngle={2}`; fixed palette `["#0B2239","#16A34A","#F59E0B","#64748B","#0EA5E9","#94A3B8"]` cycling; center `<text>` = `centerLabel` (e.g. "55 units"); side legend: slice color dot + key + units. Slices with 0 units filtered out.

- [ ] **Step 4: `index.tsx`** — `"use client"`; `const MoneyFlowChart = dynamic(() => import("./MoneyFlowChart"), { ssr: false, loading: () => <div className="h-[260px] animate-pulse rounded bg-slate-100" /> });` same for `MixDonut`; export both.

- [ ] **Step 5: Gates + commit:** eslint clean; `feat(buyback): recharts chart kit — money flow + mix donut`

---

### Task V4: Dashboard page rewrite + queue stage deep-link

**Files:**
- Modify: `src/app/(dashboard)/admin/buyback/dashboard/page.tsx` (replace the data layer + chart cards; keep the page shell, header, Card/KpiCard usage)
- Modify: the admin Review Queue page (`src/app/(dashboard)/admin/buyback/requests/page.tsx` or wherever T13's filterable queue lives — locate it) to accept `?stage=<key>` and pre-apply the matching status filter via `STAGE_BUCKETS`

**Interfaces:**
- Consumes: `GET /api/admin/buyback/dashboard` (Task V2 payload, exact field names), `MoneyFlowChart`/`MixDonut` from `@/components/buyback/charts` (Task V3), `STAGE_BUCKETS`/`stageForStatus` (Task V1).
- Produces: no exports — a page.

- [ ] **Step 1: Data layer.** Replace the 5-call fan-out (page.tsx:227-236) with one fetch of `/api/admin/buyback/dashboard` + `URLSearchParams` from filter state `{ preset: '30'|'90'|'180'|'365', dealer, vendor }`; refetch on every filter change; `loading` renders per-card skeletons; fetch error → single retry card. Date presets map to `from = now − N days`. Keep `FilterPill` for the three selects (options for dealer/vendor now come from the payload's leaderboards + an initial unfiltered fetch).

- [ ] **Step 2: KPI row.** Four `KpiCard`s from `data.kpis`; under each value render the delta: `delta === null` → nothing; else `▲ +₹2,550 vs previous 90 days` (green) / `▼ −3` (red), ₹-formatted only for margin. Margin card keeps the navy-gradient hero variant.

- [ ] **Step 3: Money flow card.** `<Card title="Money flow">` wrapping `<MoneyFlowChart data={data.money_flow} />`; when every row is all-zeros render the empty state `No settlements in this window.` instead of the chart.

- [ ] **Step 4: Funnel card.** Keep bespoke rows, upgraded: for each of the 5 stages — label, count, `units` and `₹ value_at_stake` subline, bar width = deals/maxDeals, conversion badge vs previous stage (`67%`, skipped for the first). Row = `<Link href={`/admin/buyback/requests?stage=${key}`}>` with hover ring. Delete the local bucket map (now `STAGE_BUCKETS`).

- [ ] **Step 5: Mix card.** `<Card title="Battery mix">` with chip toggle `Chemistry | Brand` (local state) → `<MixDonut data={mix[dim]} centerLabel={`${totalUnits} units`} />`; empty → `No intake lines in this window.`

- [ ] **Step 6: Leaderboards.** Keep both tables + CSV buttons; add: margin-share micro-bar per dealer row (width = margin/maxMargin, 4px, green), row click → `router.push('/admin/buyback/requests?dealer=' + entity_id)` for dealers and the vendor detail page for vendors (locate the existing vendor page route; if the queue lacks a `dealer` param, add it in the same commit exactly like `stage`).

- [ ] **Step 7: Queue `?stage=`/`?dealer=` params.** In the Review Queue page: on mount read `useSearchParams()`; `stage` → pre-set the status column filter to `STAGE_BUCKETS.find(b=>b.key===stage).statuses` (T13's filter state); `dealer` → pre-set the dealer filter. No other queue behavior changes.

- [ ] **Step 8: Live smoke** (dev server, admin cookie): dashboard renders all cards with real db-1 data; switching dealer filter changes every card; funnel stage click lands on the queue pre-filtered; empty 2020 window shows the three empty states, no blank charts, no console errors.

- [ ] **Step 9: Gates + commit:** vitest baseline; tsc baseline; eslint clean. `feat(buyback): interactive dashboard — recharts money story, live filters, click-through`

---

### Task V5: Documents APIs + shared doc-set lib

**Files:**
- Create: `src/lib/buyback/documents.ts`
- Create: `src/app/api/admin/buyback/documents/recent/route.ts`
- Create: `src/app/api/admin/buyback/documents/dealers/route.ts`
- Create: `src/app/api/admin/buyback/documents/dealers/[entityId]/route.ts`
- Modify: `src/app/api/admin/buyback/requests/[id]/documents/route.ts` (extract fan-out into the lib; response byte-identical)

**Interfaces:**
- Consumes: the existing documents route's doc-set builder (moves verbatim into the lib).
- Produces:
  - `buildDealDocumentSet(dealId: string): Promise<DealDocumentSet>` in `src/lib/buyback/documents.ts` — `DealDocumentSet` = exactly the object the existing route returns today (docs array + missing list); export the type.
  - `GET /api/admin/buyback/documents/recent?limit=8` → `{ items: { doc_type: 'quotation'|'po_dealer'|'po_vendor'|'invoice_dealer'|'invoice_vendor'|'proof_dealer'|'proof_vendor'|'eway_bill'|'weighbridge_slip', request_id: string, request_no: string, dealer_name: string, ts: string }[] }` (limit clamp ≤ 20).
  - `GET /api/admin/buyback/documents/dealers?q=&page=` → `{ items: { entity_id, name, requests, docs, last_doc_at }[], page, has_more }` (25/page, `q` ILIKE on `accounts.business_entity_name`, ordered `last_doc_at DESC NULLS LAST`; dealers with ≥1 buyback request, even if 0 docs).
  - `GET /api/admin/buyback/documents/dealers/[entityId]` → `{ dealer: { entity_id, name }, deals: { request_id, request_no, status, created_at, documents: DealDocumentSet }[] }` (deals newest-first; 404 unknown entity).

- [ ] **Step 1: Extract the lib.** Move the fan-out from `requests/[id]/documents/route.ts` into `buildDealDocumentSet(dealId)`; the route becomes resolve-request → call lib → same envelope. Verify with curl before/after: response JSON byte-identical for one CLOSED deal on db-1.

- [ ] **Step 2: `recent` route.** One `UNION ALL` query across the six file-bearing sources, each SELECT emitting `(doc_type, deal_id, ts)` — quotation: `vendor_threads WHERE quotation_pdf_s3 IS NOT NULL` (ts=created_at); POs: `purchase_orders WHERE pdf_s3 IS NOT NULL` (doc_type by leg, ts=created_at); invoices: `invoices WHERE pdf_s3 IS NOT NULL` (by leg, ts=submitted_at); proofs: `settlement_transactions WHERE proof_s3 IS NOT NULL` (by leg, ts=created_at); pickups: two arms for eway/weighbridge (ts=created_at). Wrap: join deals→requests→accounts for request_no + dealer_name, `ORDER BY ts DESC LIMIT $limit`.

- [ ] **Step 3: `dealers` route.** Aggregate over `accounts` ⋈ `buyback_requests(dealer_entity_id)` ⋈ `buyback_deals` ⋈ LATERAL doc-count subquery (sum of the six sources per deal); `HAVING COUNT(requests) ≥ 1`.

- [ ] **Step 4: `dealers/[entityId]` route.** Dealer's requests/deals newest-first (`buyback_requests_dealer_created_idx`), then `buildDealDocumentSet` per deal (`Promise.all`, deals bounded per dealer).

- [ ] **Step 5: Curl-verify** all three + the refactored route on db-1 (real dealer: "Shakti Battery House (Test)"). Gates. **Commit:** `feat(buyback): documents by dealer — recent feed, dealer directory, dealer doc view`

---

### Task V6: Documents page UI

**Files:**
- Modify: `src/app/(dashboard)/admin/buyback/documents/page.tsx`

**Interfaces:**
- Consumes: the three Task V5 endpoints (exact shapes above); existing `AdminBuybackSearch`, `DocPreviewCard`, doc-matrix rendering (all unchanged).

- [ ] **Step 1: Recent-docs dropdown.** Wrap the search area; on input focus with <2 chars, fetch `/documents/recent` (once, cached in state) and render a dropdown panel: rows = doc-type badge (small slate chip, humanized label) + `request_no` + dealer name + relative date; click → select that request (same `onSelect` path as the typeahead); ≥2 chars → existing typeahead takes over unchanged; Escape/blur closes.

- [ ] **Step 2: Dealer directory.** When no request AND no dealer is selected, replace the "Pick a deal" empty card with `<Card title="Dealers">`: small debounced search box (`q`), table Name | Requests | Documents | Last document, rows clickable (hover ring), "Load more" pagination via `page`/`has_more`.

- [ ] **Step 3: Dealer view.** Selecting a dealer fetches `/documents/dealers/[entityId]`: header (name, totals, ← All dealers back button), then per deal a section — `request_no` + status chip + date + the existing `DocPreviewCard` grid + the existing missing-docs banner for CLOSED deals. Clicking a section header jumps to the classic per-request view (sets the selected request).

- [ ] **Step 4: Live smoke:** focus → recent list appears and clicking lands in the deal's doc set; dealer table search narrows; dealer click shows all their deals' docs; RC/TXN deep search still works; PDF links open.

- [ ] **Step 5: Gates + commit:** `feat(buyback): documents page — recent docs on focus, dealer directory + dealer doc view`

---

### Task V7: Final gate (controller)

- [ ] Whole-round adversarial review (diff base…HEAD) with named checks: UI↔API field parity for all four new endpoints; every aggregate under the shared filter set (no block silently unfiltered — the exact bug this round removes); funnel stage keys identical across flow.ts/API/queue; no dealer-portal file in the diff; NO NEW TEST FILES.
- [ ] Fix wave if needed → `NODE_OPTIONS=--max-old-space-size=4096 npm run build` (box needs the heap cap).
- [ ] Live smoke on dev (charts render with real data, filters re-query, click-throughs land filtered, documents flows).
- [ ] Push `Aditya` → ff `main` → sandbox auto-deploy → verify sandbox dashboard + documents render.

## Self-Review

- **Spec coverage:** dashboard API (V2), charts+page+filters+click-through (V1/V3/V4), documents recent/directory/dealer-view + lib refactor (V5/V6), final gate (V7). Delta rules, empty states, formal-docs-only, stage deep-link all placed. No gaps.
- **Placeholders:** V1 Step 2 status lists intentionally reference the authoritative source (page.tsx:145-159) rather than restating 21 enum values from memory — the implementer copies them verbatim; that's a source pointer, not a TBD. V2's SQL is column-anchored to reports/route.ts rather than fully inlined for the same reason (invented SQL would be less safe than adapted SQL).
- **Type consistency:** `STAGE_BUCKETS` keys (`submitted|reviewed|locked|picked|settled`) used identically in V2 funnel, V4 links, queue param; `DealDocumentSet` name consistent V5→V6; chart prop names match V2 payload fields (`received/paid_out/margin_locked`).
