/**
 * GET /api/admin/buyback/dashboard?from&to&dealer&vendor   (V-round)
 *
 * ONE consolidated read for the admin buyback dashboard. Every block — KPIs
 * (with deltas), monthly money flow, the pipeline funnel, the battery mix, and
 * the dealer/vendor leaderboards — is computed server-side under the SAME
 * filter set, so a filter change moves every number on the page rather than
 * silently skipping the KPI row and funnel the way the old client-side pills
 * did.
 *
 * THE ONE RULE THAT CARRIES OVER FROM /reports: no rupee reads live catalog
 * prices. Every margin / value figure comes from `deal_line_locks` (dealer_price,
 * vendor_price, frozen at agreement, fill-once) — the same `per_deal` roll-up
 * below mirrors reports/route.ts's `lockedCte`. The catalog is never joined.
 *
 * Filters (all optional, all applied to every block):
 *   - from / to : ISO dates. Default to = now, from = now − 90d. Span clamped
 *                 to ≤ 400 days. `[from, to)` half-open so the previous window
 *                 `[from − span, from)` used for deltas never double-counts the
 *                 boundary.
 *   - dealer    : accounts.id (buyback_requests.dealer_entity_id) or omitted/"all".
 *   - vendor    : scrap_vendors.id — a deal is "for" a vendor when it has a
 *                 vendor_threads row for that vendor — or omitted/"all".
 *
 * Window column per block: requests/deals/mix/leaderboards bound on
 * buyback_requests.created_at; money_flow's received/paid_out bound on
 * settlement_transactions.txn_date and its margin_locked on buyback_deals.locked_at
 * (a locked-margin trend is keyed to WHEN the margin was locked, not when the
 * request was raised).
 */

import { sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { requireBuybackAdmin } from "@/lib/buyback/auth";
import { HttpError } from "@/lib/buyback/errors";
import { STAGE_BUCKETS, stageForStatus } from "@/lib/buyback/flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 400 * 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** accounts.id is a varchar PK (uuid-shaped in practice); accept any non-blank token. */
const ENTITY_ID_RE = /^\S{1,255}$/;

const NEGOTIATION_STATUSES = [
  "NEGOTIATING",
  "FINAL_OFFER_SENT",
  "VENDOR_ROUTED",
  "VENDOR_NEGOTIATING",
] as const;

function badRequest(message: string): never {
  // 400 for malformed filter input, via the shared {success:false,error} envelope.
  throw new HttpError(message, 400);
}

/** Parse an optional ISO date param; blank → fallback, unparseable → 400. */
function parseDate(raw: string | null, label: string, fallback: number): number {
  if (raw === null || raw === "") return fallback;
  const t = new Date(raw).getTime();
  if (Number.isNaN(t)) badRequest(`Invalid \`${label}\` date: "${raw}".`);
  return t;
}

/** Normalise a filter param that may be "all"/blank (→ null) or a real id. */
function parseIdFilter(
  raw: string | null,
  re: RegExp,
  label: string,
): string | null {
  if (raw === null || raw === "" || raw.toLowerCase() === "all") return null;
  if (!re.test(raw)) badRequest(`Invalid \`${label}\` filter.`);
  return raw;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** delta = cur − prev, or null when the previous window had no activity for it. */
function kpi(cur: number, prev: number): { value: number; delta: number | null } {
  return { value: cur, delta: prev === 0 ? null : cur - prev };
}

export const GET = withErrorHandler(async (req: Request) => {
  await requireBuybackAdmin();

  const url = new URL(req.url);
  const now = Date.now();

  const toMs = parseDate(url.searchParams.get("to"), "to", now);
  let fromMs = parseDate(url.searchParams.get("from"), "from", toMs - DEFAULT_WINDOW_MS);
  if (fromMs >= toMs) badRequest("`from` must be before `to`.");
  // Clamp an over-wide window rather than reject it — a 5-year span is a cheap
  // way to melt the DB, and 400 days already covers every real report.
  if (toMs - fromMs > MAX_WINDOW_MS) fromMs = toMs - MAX_WINDOW_MS;

  const spanMs = toMs - fromMs;
  const prevFromMs = fromMs - spanMs;

  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();
  const prevFromIso = new Date(prevFromMs).toISOString();

  const dealer = parseIdFilter(url.searchParams.get("dealer"), ENTITY_ID_RE, "dealer");
  const vendor = parseIdFilter(url.searchParams.get("vendor"), UUID_RE, "vendor");

  // Shared filter fragments — every block interpolates these, which is what
  // makes "no block silently unfiltered" hold. Both require the query to alias
  // the request as `br` and (for vendor) the deal as `bd`.
  const dealerCond = sql`(${dealer}::text IS NULL OR br.dealer_entity_id = ${dealer}::text)`;
  const vendorCond = sql`(${vendor}::uuid IS NULL OR EXISTS (
    SELECT 1 FROM vendor_threads vtf WHERE vtf.deal_id = bd.id AND vtf.vendor_id = ${vendor}::uuid
  ))`;

  // Per-deal economics from the CURRENT lock generation only — the lockedCte of
  // reports/route.ts, reshaped to one row per deal. Frozen prices, never catalog.
  const perDeal = sql`
    SELECT dll.deal_id,
           SUM(bl.quantity)                                                   AS units,
           SUM(bl.quantity * dll.dealer_price)                                AS dealer_total,
           SUM(bl.quantity * COALESCE(dll.vendor_price - dll.dealer_price, 0)) AS realised,
           SUM(bl.quantity * COALESCE(dll.vendor_price, 0))                   AS vendor_total
    FROM deal_line_locks dll
    JOIN buyback_deals bd2 ON bd2.id = dll.deal_id AND bd2.offer_version = dll.offer_version
    JOIN buyback_lines bl  ON bl.id = dll.line_id
    GROUP BY dll.deal_id
  `;

  const negIn = sql`(${sql.join(
    NEGOTIATION_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  )})`;

  const [kpiRows, moneyRows, funnelRows, chemistryRows, brandRows, dealerRows, vendorRows] =
    await Promise.all([
      // ---- KPIs (current + previous window, one pass) --------------------
      db.execute(sql`
        WITH per_deal AS (${perDeal}),
        d AS (
          SELECT bd.id, bd.status, br.dealer_entity_id,
                 (br.created_at >= ${fromIso}::timestamptz) AS is_current,
                 COALESCE(pd.realised, 0) AS realised
          FROM buyback_deals bd
          JOIN buyback_requests br ON br.id = bd.request_id
          LEFT JOIN per_deal pd ON pd.deal_id = bd.id
          WHERE br.created_at >= ${prevFromIso}::timestamptz
            AND br.created_at <  ${toIso}::timestamptz
            AND ${dealerCond} AND ${vendorCond}
        )
        SELECT
          COUNT(DISTINCT dealer_entity_id) FILTER (WHERE is_current)::int      AS dealers_cur,
          COUNT(DISTINCT dealer_entity_id) FILTER (WHERE NOT is_current)::int  AS dealers_prev,
          COUNT(*) FILTER (WHERE is_current)::int                              AS requests_cur,
          COUNT(*) FILTER (WHERE NOT is_current)::int                          AS requests_prev,
          COUNT(*) FILTER (WHERE is_current AND status IN ${negIn})::int       AS neg_cur,
          COUNT(*) FILTER (WHERE NOT is_current AND status IN ${negIn})::int   AS neg_prev,
          COALESCE(SUM(realised) FILTER (WHERE is_current AND status = 'CLOSED'), 0)     AS margin_cur,
          COALESCE(SUM(realised) FILTER (WHERE NOT is_current AND status = 'CLOSED'), 0) AS margin_prev
        FROM d
      `),

      // ---- Money flow — monthly, every month in the window (gaps zero) ---
      db.execute(sql`
        WITH per_deal AS (${perDeal}),
        months AS (
          SELECT to_char(m, 'YYYY-MM') AS month
          FROM generate_series(
            date_trunc('month', ${fromIso}::timestamptz),
            date_trunc('month', ${toIso}::timestamptz),
            interval '1 month'
          ) AS m
        ),
        settle AS (
          SELECT to_char(date_trunc('month', st.txn_date), 'YYYY-MM') AS month,
                 COALESCE(SUM(st.amount) FILTER (WHERE st.direction = 'IN'), 0)  AS received,
                 COALESCE(SUM(st.amount) FILTER (WHERE st.direction = 'OUT'), 0) AS paid_out
          FROM settlement_transactions st
          JOIN buyback_deals bd     ON bd.id = st.deal_id
          JOIN buyback_requests br  ON br.id = bd.request_id
          WHERE st.closed_at IS NOT NULL
            AND st.txn_date >= ${fromIso}::date AND st.txn_date < ${toIso}::date
            AND ${dealerCond} AND ${vendorCond}
          GROUP BY 1
        ),
        locks AS (
          SELECT to_char(date_trunc('month', bd.locked_at), 'YYYY-MM') AS month,
                 COALESCE(SUM(pd.realised), 0) AS margin_locked
          FROM buyback_deals bd
          JOIN buyback_requests br ON br.id = bd.request_id
          JOIN per_deal pd ON pd.deal_id = bd.id
          WHERE bd.locked_at IS NOT NULL
            AND bd.locked_at >= ${fromIso}::timestamptz AND bd.locked_at < ${toIso}::timestamptz
            AND ${dealerCond} AND ${vendorCond}
          GROUP BY 1
        )
        SELECT months.month,
               COALESCE(settle.received, 0)      AS received,
               COALESCE(settle.paid_out, 0)      AS paid_out,
               COALESCE(locks.margin_locked, 0)  AS margin_locked
        FROM months
        LEFT JOIN settle ON settle.month = months.month
        LEFT JOIN locks  ON locks.month  = months.month
        ORDER BY months.month
      `),

      // ---- Funnel — GROUP BY status; folded into STAGE_BUCKETS below -----
      db.execute(sql`
        WITH per_deal AS (${perDeal})
        SELECT bd.status,
               COUNT(*)::int                       AS deals,
               COALESCE(SUM(pd.units), 0)          AS units,
               COALESCE(SUM(pd.dealer_total), 0)   AS value_at_stake
        FROM buyback_deals bd
        JOIN buyback_requests br ON br.id = bd.request_id
        LEFT JOIN per_deal pd ON pd.deal_id = bd.id
        WHERE br.created_at >= ${fromIso}::timestamptz AND br.created_at < ${toIso}::timestamptz
          AND ${dealerCond} AND ${vendorCond}
        GROUP BY bd.status
      `),

      // ---- Mix: chemistry (all keys, nulls → "Not specified") ------------
      db.execute(sql`
        SELECT COALESCE(NULLIF(TRIM(bl.chemistry), ''), 'Not specified') AS key,
               COALESCE(SUM(bl.quantity), 0)::int AS units
        FROM buyback_lines bl
        JOIN buyback_batches bb  ON bb.id = bl.batch_id
        JOIN buyback_requests br ON br.id = bb.request_id
        LEFT JOIN buyback_deals bd ON bd.request_id = br.id
        WHERE br.created_at >= ${fromIso}::timestamptz AND br.created_at < ${toIso}::timestamptz
          AND ${dealerCond} AND ${vendorCond}
        GROUP BY 1
        HAVING COALESCE(SUM(bl.quantity), 0) > 0
        ORDER BY units DESC, key
      `),

      // ---- Mix: brand (top 5 + "Other" folded in JS) ---------------------
      db.execute(sql`
        SELECT COALESCE(NULLIF(TRIM(bl.brand), ''), 'Not specified') AS key,
               COALESCE(SUM(bl.quantity), 0)::int AS units
        FROM buyback_lines bl
        JOIN buyback_batches bb  ON bb.id = bl.batch_id
        JOIN buyback_requests br ON br.id = bb.request_id
        LEFT JOIN buyback_deals bd ON bd.request_id = br.id
        WHERE br.created_at >= ${fromIso}::timestamptz AND br.created_at < ${toIso}::timestamptz
          AND ${dealerCond} AND ${vendorCond}
        GROUP BY 1
        HAVING COALESCE(SUM(bl.quantity), 0) > 0
        ORDER BY units DESC, key
      `),

      // ---- Dealer leaderboard — top 20 by locked margin ------------------
      db.execute(sql`
        WITH per_deal AS (${perDeal})
        SELECT br.dealer_entity_id                                             AS entity_id,
               da.business_entity_name                                         AS name,
               COUNT(*)::int                                                   AS deals,
               COUNT(*) FILTER (WHERE bd.status = 'CLOSED')::int               AS closed,
               COALESCE(SUM(pd.realised) FILTER (WHERE bd.status = 'CLOSED'), 0) AS margin,
               COALESCE(SUM(pd.dealer_total), 0)                              AS paid_out
        FROM buyback_deals bd
        JOIN buyback_requests br ON br.id = bd.request_id
        JOIN accounts da         ON da.id = br.dealer_entity_id
        LEFT JOIN per_deal pd ON pd.deal_id = bd.id
        WHERE br.created_at >= ${fromIso}::timestamptz AND br.created_at < ${toIso}::timestamptz
          AND ${dealerCond} AND ${vendorCond}
        GROUP BY br.dealer_entity_id, da.business_entity_name
        ORDER BY margin DESC NULLS LAST, paid_out DESC
        LIMIT 20
      `),

      // ---- Vendor leaderboard — top 20 by rupee volume bought ------------
      db.execute(sql`
        WITH per_deal AS (${perDeal})
        SELECT sv.id                                                          AS vendor_id,
               a.business_entity_name                                         AS name,
               COUNT(*)::int                                                  AS threads,
               COUNT(*) FILTER (WHERE vt.status = 'AGREED')::int              AS won,
               COALESCE(ROUND(
                 100.0 * COUNT(*) FILTER (WHERE vt.status = 'AGREED') / NULLIF(COUNT(*), 0)
               ), 0)::int                                                     AS bid_to_win,
               COALESCE(SUM(pd.vendor_total) FILTER (WHERE vt.status = 'AGREED'), 0) AS bought
        FROM vendor_threads vt
        JOIN scrap_vendors sv    ON sv.id = vt.vendor_id
        JOIN accounts a          ON a.id = sv.entity_id
        JOIN buyback_deals bd    ON bd.id = vt.deal_id
        JOIN buyback_requests br ON br.id = bd.request_id
        LEFT JOIN per_deal pd ON pd.deal_id = vt.deal_id
        WHERE br.created_at >= ${fromIso}::timestamptz AND br.created_at < ${toIso}::timestamptz
          AND ${dealerCond} AND ${vendorCond}
        GROUP BY sv.id, a.business_entity_name
        ORDER BY bought DESC, threads DESC
        LIMIT 20
      `),
    ]);

  const k = (kpiRows as unknown as Array<Record<string, unknown>>)[0] ?? {};

  const kpis = {
    dealers: kpi(num(k.dealers_cur), num(k.dealers_prev)),
    requests: kpi(num(k.requests_cur), num(k.requests_prev)),
    active_negotiations: kpi(num(k.neg_cur), num(k.neg_prev)),
    margin: kpi(num(k.margin_cur), num(k.margin_prev)),
  };

  const money_flow = (moneyRows as unknown as Array<Record<string, unknown>>).map((r) => ({
    month: String(r.month),
    received: num(r.received),
    paid_out: num(r.paid_out),
    margin_locked: num(r.margin_locked),
  }));

  // Fold the per-status funnel rows into the 5 fixed stages, in order, always
  // emitting all five (zeros included). Statuses outside every bucket (DRAFT,
  // DEALER_REOPENED, REJECTED, CANCELLED) are dropped — same as the old map.
  const funnelByKey = new Map(
    STAGE_BUCKETS.map((b) => [
      b.key,
      { stage: b.label, key: b.key, deals: 0, units: 0, value_at_stake: 0 },
    ]),
  );
  for (const r of funnelRows as unknown as Array<Record<string, unknown>>) {
    const key = stageForStatus(String(r.status));
    if (!key) continue;
    const bucket = funnelByKey.get(key)!;
    bucket.deals += num(r.deals);
    bucket.units += num(r.units);
    bucket.value_at_stake += num(r.value_at_stake);
  }
  const funnel = STAGE_BUCKETS.map((b) => funnelByKey.get(b.key)!);

  const chemistry = (chemistryRows as unknown as Array<Record<string, unknown>>).map((r) => ({
    key: String(r.key),
    units: num(r.units),
  }));

  // Brand: keep the top 5 by units (already ordered by the query), fold the
  // long tail into a single "Other" slice.
  const brandAll = (brandRows as unknown as Array<Record<string, unknown>>).map((r) => ({
    key: String(r.key),
    units: num(r.units),
  }));
  const brand = brandAll.slice(0, 5);
  const otherUnits = brandAll.slice(5).reduce((s, r) => s + r.units, 0);
  if (otherUnits > 0) brand.push({ key: "Other", units: otherUnits });

  const dealers = (dealerRows as unknown as Array<Record<string, unknown>>).map((r) => ({
    entity_id: String(r.entity_id),
    name: String(r.name),
    deals: num(r.deals),
    closed: num(r.closed),
    margin: num(r.margin),
    paid_out: num(r.paid_out),
  }));

  const vendors = (vendorRows as unknown as Array<Record<string, unknown>>).map((r) => ({
    vendor_id: String(r.vendor_id),
    name: String(r.name),
    threads: num(r.threads),
    won: num(r.won),
    bid_to_win: num(r.bid_to_win),
    bought: num(r.bought),
  }));

  return successResponse({
    kpis,
    money_flow,
    funnel,
    mix: { chemistry, brand },
    dealers,
    vendors,
    // Same claim /reports makes, as data: every rupee traces to the locks.
    source: "deal_line_locks (frozen at agreement) — never live catalog prices",
  });
});
