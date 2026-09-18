/**
 * Daily Scrap / Buyback digest.
 *
 * Two flows in one mail, kept apart everywhere — separate labels, separate
 * sections, and a separate worksheet each in the attachment:
 *
 *   · Scrap (NBFC consignments) — NBFC → iTarang scrap lots, `scrap_consignments`
 *     (vocabulary in src/lib/nbfc/scrap/consignment.ts).
 *   · Dealer Buyback — `buyback_requests` / `buyback_deals` /
 *     `settlement_transactions` / `deal_line_locks`.
 *
 * OUT OF SCOPE: NBFC customer buyback (`nbfc_buyback_requests`), `auction_*`,
 * `refurbishment_*`. Do not join them in here.
 *
 * TIMESTAMPS: every date column used here is `timestamptz`, so every window is
 * `istDayWindowTz` (window.ts). `settlement_transactions.txn_date` is a DATE and
 * is compared to the IST day directly, exactly as the buyback dashboard does.
 *
 * MONEY: every buyback rupee comes from `deal_line_locks` (current lock
 * generation), never the catalog — the rule and the per-deal roll-up are
 * mirrored from api/admin/buyback/dashboard/route.ts (`perDeal`) and
 * api/admin/buyback/reports/route.ts (`lockedCte`). "Margin locked" is keyed to
 * `buyback_deals.locked_at` like the dashboard's money-flow block; "margin
 * earned" is the realised margin of deals that moved to CLOSED on the day, the
 * dashboard's CLOSED-only margin. Open-deal idle days follow the reports' aging
 * block (`now() − updated_at`).
 *
 * "Deals that changed status" reads `buyback_activity_log` (INSERT-only, written
 * in the same transaction as every transition) — `buyback_deals` keeps only the
 * current status, so a deal that moved twice in a day would otherwise be missed.
 */

import { sql } from "drizzle-orm";

// `db` is imported inside each query — see dealer-validation.ts for why.

import { istDayWindowTz } from "../window";
import type { DigestDetail, DigestFigures, DigestKindDescriptor, DigestSection } from "../types";
import {
  buybackMoveRows,
  buybackRequestRows,
  buybackSettlementRows,
  num,
  scrapBuybackFigures,
  scrapConsignmentRows,
  scrapNbfcRows,
  type BuybackDayCounts,
  type ScrapDayCounts,
} from "./scrap-buyback-shape";

const SECTIONS: DigestSection[] = [
  { key: "scrapSubmitted", label: "Scrap · submitted", hint: "NBFC consignments submitted, with batteries and asking amount.", group: "activity" },
  { key: "scrapAgreed", label: "Scrap · agreed", hint: "Consignments where a rate was agreed, with batteries and agreed amount.", group: "activity" },
  { key: "scrapPaid", label: "Scrap · paid", hint: "Consignments paid out to the NBFC, and the amount.", group: "activity" },
  { key: "scrapRejected", label: "Scrap · rejected / withdrawn", hint: "Consignments rejected by iTarang or withdrawn by the NBFC.", group: "activity" },
  { key: "scrapByNbfc", label: "Scrap · per NBFC", hint: "One row per NBFC with that day's scrap activity (detailed mail and Excel).", group: "activity" },
  { key: "buybackRequests", label: "Buyback · new requests", hint: "Dealer buyback requests submitted, split by source (web / WhatsApp / CSV).", group: "activity" },
  { key: "buybackMoves", label: "Buyback · status changes", hint: "Deals that moved status that day, by the status they moved into.", group: "activity" },
  { key: "buybackSettlement", label: "Buyback · settlements", hint: "Settlement transactions closed that day: received from vendors, paid to dealers.", group: "activity" },
  { key: "buybackMargin", label: "Buyback · margin", hint: "Margin locked that day, and margin earned on deals closed that day.", group: "activity" },
  { key: "scrapBacklog", label: "Scrap · open backlog", hint: "Open NBFC consignments by status, unpaid agreed amount, oldest open.", group: "backlog" },
  { key: "buybackBacklog", label: "Buyback · open pipeline", hint: "Open dealer buyback deals by stage (same stages as the buyback dashboard), value at stake.", group: "backlog" },
  { key: "buybackAging", label: "Buyback · aging", hint: "Open deals idle more than 7 / 30 days, and the longest idle.", group: "backlog" },
];

type Row = Record<string, unknown>;

function nullableInt(v: unknown): number | null {
  return v == null ? null : Math.max(0, Math.floor(num(v)));
}

function parseStatusCounts(raw: unknown): Array<{ status: string; deals: number; value: number }> {
  if (!Array.isArray(raw)) return [];
  return (raw as Row[]).map((r) => ({
    status: String(r.status ?? ""),
    deals: num(r.deals),
    value: num(r.value),
  }));
}

async function collectScrap(istDay: string): Promise<ScrapDayCounts> {
  const { db } = await import("@/lib/db");
  const inDay = (col: string) => istDayWindowTz(sql.raw(`c.${col}`), istDay);

  const rows = (await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE ${inDay("submitted_at")})::int                         AS submitted,
      COALESCE(SUM(c.battery_count) FILTER (WHERE ${inDay("submitted_at")}), 0)     AS submitted_batteries,
      COALESCE(SUM(c.asking_amount) FILTER (WHERE ${inDay("submitted_at")}), 0)     AS submitted_asking,
      COUNT(*) FILTER (WHERE ${inDay("agreed_at")})::int                            AS agreed,
      COALESCE(SUM(c.battery_count) FILTER (WHERE ${inDay("agreed_at")}), 0)        AS agreed_batteries,
      COALESCE(SUM(c.agreed_amount) FILTER (WHERE ${inDay("agreed_at")}), 0)        AS agreed_amount,
      COUNT(*) FILTER (WHERE c.paid_at IS NOT NULL AND ${inDay("paid_at")})::int    AS paid,
      COALESCE(SUM(c.agreed_amount) FILTER (WHERE c.paid_at IS NOT NULL AND ${inDay("paid_at")}), 0) AS paid_amount,
      COUNT(*) FILTER (WHERE c.status = 'rejected'  AND ${inDay("closed_at")})::int AS rejected,
      COUNT(*) FILTER (WHERE c.status = 'withdrawn' AND ${inDay("closed_at")})::int AS withdrawn,
      COUNT(DISTINCT c.tenant_id) FILTER (WHERE
             ${inDay("submitted_at")} OR ${inDay("agreed_at")} OR ${inDay("paid_at")}
          OR (c.status IN ('rejected', 'withdrawn') AND ${inDay("closed_at")}))::int AS nbfcs_active,
      COUNT(*) FILTER (WHERE c.status = 'draft')::int                               AS open_draft,
      COUNT(*) FILTER (WHERE c.status = 'submitted')::int                           AS open_submitted,
      COUNT(*) FILTER (WHERE c.status = 'negotiating')::int                         AS open_negotiating,
      COUNT(*) FILTER (WHERE c.status = 'agreed')::int                              AS open_agreed,
      COALESCE(SUM(c.agreed_amount) FILTER (WHERE c.status = 'agreed'), 0)          AS open_agreed_unpaid_amount,
      COALESCE(SUM(c.battery_count) FILTER (WHERE c.status IN ('submitted','negotiating','agreed')), 0) AS open_batteries,
      FLOOR(EXTRACT(EPOCH FROM (now() - MIN(COALESCE(c.submitted_at, c.created_at))
        FILTER (WHERE c.status IN ('submitted','negotiating','agreed')))) / 86400)  AS oldest_open_days
    FROM scrap_consignments c
  `)) as unknown as Row[];

  const r = rows?.[0] ?? {};
  return {
    submitted: num(r.submitted),
    submitted_batteries: num(r.submitted_batteries),
    submitted_asking: num(r.submitted_asking),
    agreed: num(r.agreed),
    agreed_batteries: num(r.agreed_batteries),
    agreed_amount: num(r.agreed_amount),
    paid: num(r.paid),
    paid_amount: num(r.paid_amount),
    rejected: num(r.rejected),
    withdrawn: num(r.withdrawn),
    nbfcs_active: num(r.nbfcs_active),
    open_draft: num(r.open_draft),
    open_submitted: num(r.open_submitted),
    open_negotiating: num(r.open_negotiating),
    open_agreed: num(r.open_agreed),
    open_agreed_unpaid_amount: num(r.open_agreed_unpaid_amount),
    open_batteries: num(r.open_batteries),
    oldest_open_days: nullableInt(r.oldest_open_days),
  };
}

/**
 * Deal status transitions on the day, one row per (deal, status entered).
 * Shared by the counts and the detail query.
 */
function movesCte(istDay: string) {
  return sql`
    SELECT DISTINCT ON (a.deal_id, a.after->>'status')
           a.deal_id, a.request_id, a.role, a.created_at,
           a.before->>'status' AS from_status,
           a.after->>'status'  AS to_status
      FROM buyback_activity_log a
     WHERE a.deal_id IS NOT NULL
       AND ${istDayWindowTz(sql`a.created_at`, istDay)}
       AND (a.after->>'status') IS NOT NULL
       AND (a.after->>'status') IS DISTINCT FROM (a.before->>'status')
     ORDER BY a.deal_id, a.after->>'status', a.created_at DESC
  `;
}

async function collectBuyback(istDay: string): Promise<BuybackDayCounts> {
  const { db } = await import("@/lib/db");

  // Per-deal economics from the CURRENT lock generation — dashboard `perDeal`.
  // Bounded to deals still open or touched on/after the day (a deal locked or
  // closed on the day has updated_at >= that day), so it never full-scans locks.
  const perDeal = sql`
    SELECT dll.deal_id,
           SUM(bl.quantity * dll.dealer_price)                                AS dealer_total,
           SUM(bl.quantity * COALESCE(dll.vendor_price - dll.dealer_price, 0)) AS realised
      FROM deal_line_locks dll
      JOIN buyback_deals bd2 ON bd2.id = dll.deal_id AND bd2.offer_version = dll.offer_version
      JOIN buyback_lines bl  ON bl.id = dll.line_id
     WHERE bd2.status NOT IN ('DRAFT', 'CLOSED', 'REJECTED', 'CANCELLED')
        OR bd2.updated_at >= (${istDay}::date::timestamp AT TIME ZONE 'Asia/Kolkata')
     GROUP BY dll.deal_id
  `;

  const rows = (await db.execute(sql`
    WITH per_deal AS (${perDeal}),
    moves AS (${movesCte(istDay)}),
    open_deals AS (
      SELECT bd.id, bd.status, bd.updated_at, COALESCE(pd.dealer_total, 0) AS value
        FROM buyback_deals bd
        LEFT JOIN per_deal pd ON pd.deal_id = bd.id
       WHERE bd.status NOT IN ('DRAFT', 'CLOSED', 'REJECTED', 'CANCELLED')
    )
    SELECT
      (SELECT COUNT(*) FROM buyback_requests br
        WHERE br.submitted_at IS NOT NULL
          AND ${istDayWindowTz(sql`br.submitted_at`, istDay)})::int                AS requests,
      (SELECT COUNT(*) FROM buyback_requests br
        WHERE br.source_channel = 'WEB' AND br.submitted_at IS NOT NULL
          AND ${istDayWindowTz(sql`br.submitted_at`, istDay)})::int                AS requests_web,
      (SELECT COUNT(*) FROM buyback_requests br
        WHERE br.source_channel = 'WHATSAPP' AND br.submitted_at IS NOT NULL
          AND ${istDayWindowTz(sql`br.submitted_at`, istDay)})::int                AS requests_whatsapp,
      (SELECT COUNT(*) FROM buyback_requests br
        WHERE br.source_channel = 'CSV' AND br.submitted_at IS NOT NULL
          AND ${istDayWindowTz(sql`br.submitted_at`, istDay)})::int                AS requests_csv,
      (SELECT COUNT(DISTINCT m.deal_id) FROM moves m)::int                         AS moved_deals,
      (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
         SELECT m.to_status AS status, COUNT(DISTINCT m.deal_id)::int AS deals, 0 AS value
           FROM moves m GROUP BY m.to_status) x)                                   AS moves,
      (SELECT COUNT(*) FROM settlement_transactions st
        WHERE st.closed_at IS NOT NULL AND st.txn_date = ${istDay}::date)::int     AS settle_txns,
      (SELECT COALESCE(SUM(st.amount), 0) FROM settlement_transactions st
        WHERE st.closed_at IS NOT NULL AND st.direction = 'IN'
          AND st.txn_date = ${istDay}::date)                                       AS received,
      (SELECT COALESCE(SUM(st.amount), 0) FROM settlement_transactions st
        WHERE st.closed_at IS NOT NULL AND st.direction = 'OUT'
          AND st.txn_date = ${istDay}::date)                                       AS paid_out,
      (SELECT COALESCE(SUM(pd.realised), 0) FROM buyback_deals bd
         JOIN per_deal pd ON pd.deal_id = bd.id
        WHERE bd.locked_at IS NOT NULL
          AND bd.status NOT IN ('REJECTED', 'CANCELLED')
          AND ${istDayWindowTz(sql`bd.locked_at`, istDay)})                        AS margin_locked,
      (SELECT COALESCE(SUM(pd.realised), 0) FROM buyback_deals bd
         JOIN per_deal pd ON pd.deal_id = bd.id
        WHERE bd.status = 'CLOSED'
          AND EXISTS (SELECT 1 FROM moves m WHERE m.deal_id = bd.id AND m.to_status = 'CLOSED')) AS margin_closed,
      (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
         SELECT o.status::text AS status, COUNT(*)::int AS deals, COALESCE(SUM(o.value), 0) AS value
           FROM open_deals o GROUP BY o.status) x)                                 AS open_by_status,
      (SELECT COUNT(*) FROM open_deals o WHERE o.updated_at < now() - interval '7 days')::int  AS idle_over_7,
      (SELECT COUNT(*) FROM open_deals o WHERE o.updated_at < now() - interval '30 days')::int AS idle_over_30,
      (SELECT FLOOR(EXTRACT(EPOCH FROM (now() - MIN(o.updated_at))) / 86400) FROM open_deals o) AS oldest_idle_days
  `)) as unknown as Row[];

  const r = rows?.[0] ?? {};
  return {
    requests: num(r.requests),
    requests_web: num(r.requests_web),
    requests_whatsapp: num(r.requests_whatsapp),
    requests_csv: num(r.requests_csv),
    moved_deals: num(r.moved_deals),
    moves: parseStatusCounts(r.moves).map(({ status, deals }) => ({ status, deals })),
    settle_txns: num(r.settle_txns),
    received: num(r.received),
    paid_out: num(r.paid_out),
    margin_locked: num(r.margin_locked),
    margin_closed: num(r.margin_closed),
    open_by_status: parseStatusCounts(r.open_by_status),
    idle_over_7: num(r.idle_over_7),
    idle_over_30: num(r.idle_over_30),
    oldest_idle_days: nullableInt(r.oldest_idle_days),
  };
}

async function collect(
  istDay: string,
): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    // Two flows, two statements — independent tables, and one flow's schema
    // drift must be visible in the error rather than hidden in a shared query.
    const [scrap, buyback] = await Promise.all([collectScrap(istDay), collectBuyback(istDay)]);
    return { ok: true, figures: scrapBuybackFigures(scrap, buyback) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[digest:scrap_buyback_daily] count query failed:", error);
    return { ok: false, figures: { activity: [], backlog: [] }, error };
  }
}

async function collectDetail(
  istDay: string,
): Promise<{ ok: boolean; detail: DigestDetail; error?: string }> {
  const CAP = 200;
  try {
    const { db } = await import("@/lib/db");
    const inDay = (col: string) => istDayWindowTz(sql.raw(`c.${col}`), istDay);

    const scrapConsignment = (where: ReturnType<typeof sql>, atCol: string, amountCol: string) => sql`
      (SELECT COALESCE(json_agg(x ORDER BY x.at DESC), '[]'::json) FROM (
         SELECT c.id, c.ref_code, t.display_name AS nbfc, c.battery_count,
                c.pickup_city AS city, c.pickup_state AS state,
                ${sql.raw(`c.${amountCol}`)} AS amount, ${sql.raw(`c.${atCol}`)} AS at
           FROM scrap_consignments c
           LEFT JOIN nbfc_tenants t ON t.id = c.tenant_id
          WHERE ${where}
          LIMIT ${CAP}) x)`;

    const [scrapRows, buybackRows] = await Promise.all([
      db.execute(sql`
        SELECT
          ${scrapConsignment(inDay("submitted_at"), "submitted_at", "asking_amount")} AS submitted,
          ${scrapConsignment(inDay("agreed_at"), "agreed_at", "agreed_amount")}       AS agreed,
          ${scrapConsignment(sql`c.paid_at IS NOT NULL AND ${inDay("paid_at")}`, "paid_at", "agreed_amount")} AS paid,
          ${scrapConsignment(sql`c.status = 'rejected' AND ${inDay("closed_at")}`, "closed_at", "asking_amount")} AS rejected,
          ${scrapConsignment(sql`c.status = 'withdrawn' AND ${inDay("closed_at")}`, "closed_at", "asking_amount")} AS withdrawn,
          (SELECT COALESCE(json_agg(x ORDER BY x.nbfc), '[]'::json) FROM (
             SELECT c.tenant_id, MAX(t.display_name) AS nbfc,
                    COUNT(*) FILTER (WHERE ${inDay("submitted_at")})::int                     AS submitted,
                    COALESCE(SUM(c.battery_count) FILTER (WHERE ${inDay("submitted_at")}), 0) AS batteries,
                    COALESCE(SUM(c.asking_amount) FILTER (WHERE ${inDay("submitted_at")}), 0) AS asking,
                    COUNT(*) FILTER (WHERE ${inDay("agreed_at")})::int                        AS agreed,
                    COALESCE(SUM(c.agreed_amount) FILTER (WHERE ${inDay("agreed_at")}), 0)    AS agreed_amount,
                    COUNT(*) FILTER (WHERE c.paid_at IS NOT NULL AND ${inDay("paid_at")})::int AS paid,
                    COALESCE(SUM(c.agreed_amount) FILTER (WHERE c.paid_at IS NOT NULL AND ${inDay("paid_at")}), 0) AS paid_amount,
                    COUNT(*) FILTER (WHERE c.status = 'rejected'  AND ${inDay("closed_at")})::int AS rejected,
                    COUNT(*) FILTER (WHERE c.status = 'withdrawn' AND ${inDay("closed_at")})::int AS withdrawn
               FROM scrap_consignments c
               LEFT JOIN nbfc_tenants t ON t.id = c.tenant_id
              WHERE ${inDay("submitted_at")} OR ${inDay("agreed_at")} OR ${inDay("paid_at")}
                 OR (c.status IN ('rejected', 'withdrawn') AND ${inDay("closed_at")})
              GROUP BY c.tenant_id
              LIMIT ${CAP}) x) AS by_nbfc
      `),
      db.execute(sql`
        WITH moves AS (${movesCte(istDay)})
        SELECT
          (SELECT COALESCE(json_agg(x ORDER BY x.at DESC), '[]'::json) FROM (
             SELECT br.id, br.request_no, br.source_channel, br.submitted_at AS at,
                    a.business_entity_name AS dealer, a.city, a.state
               FROM buyback_requests br
               LEFT JOIN accounts a ON a.id = br.dealer_entity_id
              WHERE br.submitted_at IS NOT NULL
                AND ${istDayWindowTz(sql`br.submitted_at`, istDay)}
              LIMIT ${CAP}) x) AS requests,
          (SELECT COALESCE(json_agg(x ORDER BY x.at DESC), '[]'::json) FROM (
             SELECT m.deal_id, m.from_status, m.to_status, m.role, m.created_at AS at,
                    br.request_no, a.business_entity_name AS dealer, a.city, a.state
               FROM moves m
               JOIN buyback_requests br ON br.id = m.request_id
               LEFT JOIN accounts a ON a.id = br.dealer_entity_id
              LIMIT ${CAP}) x) AS moves,
          (SELECT COALESCE(json_agg(x ORDER BY x.at DESC), '[]'::json) FROM (
             SELECT st.id, st.leg::text AS leg, st.direction::text AS direction,
                    st.method::text AS method, st.amount, st.txn_ref, st.closed_at AS at,
                    br.request_no, a.business_entity_name AS dealer
               FROM settlement_transactions st
               JOIN buyback_deals bd    ON bd.id = st.deal_id
               JOIN buyback_requests br ON br.id = bd.request_id
               LEFT JOIN accounts a     ON a.id = br.dealer_entity_id
              WHERE st.closed_at IS NOT NULL AND st.txn_date = ${istDay}::date
              LIMIT ${CAP}) x) AS settlements
      `),
    ]);

    const s = ((scrapRows as unknown as Row[])?.[0] ?? {}) as Row;
    const b = ((buybackRows as unknown as Row[])?.[0] ?? {}) as Row;

    return {
      ok: true,
      detail: {
        scrapSubmitted: scrapConsignmentRows(s.submitted, "asking"),
        scrapAgreed: scrapConsignmentRows(s.agreed, "agreed"),
        scrapPaid: scrapConsignmentRows(s.paid, "paid"),
        scrapRejected: scrapConsignmentRows(s.rejected, "asked"),
        scrapWithdrawn: scrapConsignmentRows(s.withdrawn, "asked"),
        scrapByNbfc: scrapNbfcRows(s.by_nbfc),
        buybackRequests: buybackRequestRows(b.requests),
        buybackMoves: buybackMoveRows(b.moves),
        buybackSettlements: buybackSettlementRows(b.settlements),
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[digest:scrap_buyback_daily] detail query failed:", error);
    return { ok: false, detail: {}, error };
  }
}

export const scrapBuybackDigest: DigestKindDescriptor = {
  id: "scrap_buyback_daily",
  label: "Scrap / Buyback",
  description:
    "A daily report on NBFC scrap consignments and the dealer buyback pipeline, kept as " +
    "two separate sections (and two separate sheets in the Excel). The morning mail " +
    "reports yesterday; the evening mail reports today so far. NBFC customer buyback, " +
    "auctions and refurbishment are not included.",
  settingsKey: "scrap_buyback_daily_digest",
  settingsHref: "/admin/settings/scrap-buyback",
  ctaHref: "/admin/buyback/dashboard",
  ctaLabel: "Open Buyback Dashboard",
  sections: SECTIONS,
  collect,
  collectDetail,
};
