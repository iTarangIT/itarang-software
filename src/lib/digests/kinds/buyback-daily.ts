/**
 * Buyback Daily digest (B9) — revised Format B (Reporting Review v1.0, sheet
 * 4_Email_Buyback; tracker ID 10, 01 Oct 2026). One mail every morning:
 *
 *   A · Company headline   nine metrics × Yesterday / Last 7 days / MTD /
 *                          MTD target / % of target / same period last month
 *   B · Per SPOC           the same activity per request owner and period
 *   C · Pipeline           open requests per owner by where they are stuck
 *   D · Pickups            today and tomorrow, with expected kg today
 *
 * This file is the queries; the row shaping is ./buyback-daily-shape.ts (pure,
 * unit-tested).
 *
 * WHO THE SPOC IS. `buyback_requests.owner_id` (E-302, review R-12) — set at
 * creation from the dealer's CRM owner (GSTIN match) and by Claim / Assign on
 * the admin request page. Every figure about a request, quotes and money
 * included, is credited to that owner; a request nobody owns shows as
 * "(unassigned)" so the gap is visible rather than hidden.
 *
 * DEFINITIONS, per period [from, to] in IST, per SPOC:
 *   Requests received        requests submitted in the period (submitted_at,
 *                            else created_at), drafts excluded.
 *   Dealers called (unique)  distinct dealer_lead_id on HUMAN calls performed
 *                            by the SPOC — humanCall() in metricDefinitions.ts,
 *                            the Sales Daily rule (ID 59): no AI-dialer calls,
 *                            a NeoDove re-disposition counted once — narrowed
 *                            to BUYBACK leads (tracker ID 10): the lead's Type
 *                            of Business is 'buyback' (E-296), or the lead is
 *                            the CRM lead of a dealer with a buyback request
 *                            (request → accounts.gstin → dealerLeadByGstin,
 *                            the rule that sets the request's owner). A call
 *                            about a battery sale is not buyback effort.
 *   Images received          requests whose FIRST photo (MIN created_at over
 *                            every photo on every line of the request) fell in
 *                            the period — a request counts once, never once per
 *                            photo.
 *   Quotes shared            final_offers.sent_at in the period.
 *   Quotes accepted          deals that logged `dealer_accept` in the period —
 *                            the "Scrap deals" target metric, and the only
 *                            buyback metric the targets register carries.
 *   Pickups completed        deals that logged `complete_pickup` in the period.
 *   Kg sourced               Σ quantity × unit_weight_kg over the lines of those
 *                            picked-up requests (`unit_weight_kg` is kilograms).
 *                            Lines with no weight count 0 — so "Lines missing
 *                            weight" sits beside kg (review R-13): the
 *                            under-count is shown, never silent.
 *   ₹ paid                   settlement_transactions on the DEALER leg dated
 *                            (txn_date) in the period — the CEO control tower's
 *                            buyback tile reads the same rows.
 *   Avg ₹ / kg               ₹ paid ÷ kg sourced, "—" when nothing was weighed.
 *   Gross margin             for each deal whose recycler sale (a VENDOR-leg
 *                            settlement) was booked in the period: everything
 *                            received from the recycler minus everything paid to
 *                            the dealer on that deal. "—" when none was booked.
 *
 * PIPELINE (as of the send, one row per owner; open deals only):
 *   Awaiting images              under review, no photo on any line yet
 *   Images in, quote not sent    photos in, no final offer sent yet
 *   Quote sent, no reply > 2d    FINAL_OFFER_SENT, latest offer sent > 2 days ago
 *   Accepted, pickup not scheduled   DEALER_ACCEPTED … PO_EXCHANGED (vendor leg)
 *   Pickup scheduled             PICKUP_SCHEDULED
 *   Aged > 3d in any stage       the deal has not moved (updated_at) for 3 days
 *   Oldest open request (days)   since it was submitted
 *
 * `db` is imported inside the queries, never at module scope — listing the
 * registry must not require DATABASE_URL (see kyc-review.ts).
 */

import { sql } from "drizzle-orm";

import { dealerLeadByGstin, GSTIN_KEY } from "@/lib/leads/gstinMatch";
import { humanCall } from "@/lib/reports/metricDefinitions";
import { monthEnd, workingDaysBetween } from "@/lib/targets/rules";

import { istRangeTz } from "../window";
import type {
  DigestDetail,
  DigestFigures,
  DigestKindDescriptor,
  DigestSection,
  DigestTable,
} from "../types";
import {
  BLOCK_A_COLUMNS,
  BLOCK_B_COLUMNS,
  UNASSIGNED,
  blockARows,
  blockBRows,
  buybackHeadline,
  hasBuybackFigure,
  sumFigures,
  type BuybackSpocRow,
} from "./buyback-daily-shape";

const SECTIONS: DigestSection[] = [
  {
    key: "summary",
    label: "Headline",
    hint: "One line at the top: kg sourced, requests, quotes, pickups and ₹ paid yesterday.",
    group: "activity",
  },
  {
    key: "company",
    label: "A · Company headline",
    hint: "Nine metrics — yesterday, last 7 days, month to date, MTD target, % of target, same period last month.",
    group: "activity",
  },
  {
    key: "per_spoc",
    label: "B · Per SPOC",
    hint: "Per request owner: requests, dealers called, images, quotes, pickups, kg and ₹ paid — yesterday, last 7 days and month to date.",
    group: "activity",
  },
  {
    key: "pipeline",
    label: "C · Buyback pipeline",
    hint: "Per owner, once: open requests by where they are waiting, as of this morning.",
    group: "backlog",
  },
  {
    key: "today",
    label: "D · Pickups today and tomorrow",
    hint: "Pickups each SPOC has scheduled for today and tomorrow, and the kg expected today.",
    group: "backlog",
  },
];

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const firstOfMonth = (iso: string) => `${iso.slice(0, 7)}-01`;
/** 1st of last month → the same day of last month (capped at its last day). */
function sameSpanLastMonth(iso: string): { from: string; to: string } {
  const d = new Date(`${iso}T00:00:00Z`);
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).getUTCDate();
  const to = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d.getUTCDate(), lastDay)));
  return { from: first.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * One row per SPOC for one period. Every figure is grouped on its own natural
 * key first (request → owner, touchpoint → performer) and the groups are
 * unioned and summed, so a SPOC with only quotes still appears. Rows with no
 * buyback figure at all (a person who only made calls) are returned too — the
 * caller decides what to show.
 */
async function periodRows(from: string, to: string): Promise<BuybackSpocRow[]> {
  const { db } = await import("@/lib/db");
  const rows = (await db.execute(sql`
    WITH request_spoc AS (
      -- The request's owner (E-302). NULL = unassigned.
      SELECT br.id AS request_id, br.owner_id AS spoc FROM buyback_requests br
    ),
    received AS (
      SELECT br.id AS request_id
        FROM buyback_requests br
        LEFT JOIN buyback_deals d ON d.request_id = br.id
       WHERE COALESCE(d.status::text, '') <> 'DRAFT'
         AND ${istRangeTz(sql`COALESCE(br.submitted_at, br.created_at)`, from, to)}
    ),
    request_kg AS (
      SELECT b.request_id,
             COALESCE(SUM(l.quantity * l.unit_weight_kg), 0) AS kg,
             COUNT(*) FILTER (WHERE COALESCE(l.unit_weight_kg, 0) <= 0) AS missing_weight
        FROM buyback_batches b
        JOIN buyback_lines l ON l.batch_id = b.id
       GROUP BY b.request_id
    ),
    picked AS (
      -- A deal that completed pickup in the period; one row per deal.
      SELECT DISTINCT al.request_id
        FROM buyback_activity_log al
       WHERE al.action = 'complete_pickup'
         AND ${istRangeTz(sql`al.created_at`, from, to)}
    ),
    accepted AS (
      SELECT DISTINCT al.request_id
        FROM buyback_activity_log al
       WHERE al.action = 'dealer_accept'
         AND ${istRangeTz(sql`al.created_at`, from, to)}
    ),
    first_photo AS (
      SELECT b.request_id, MIN(p.created_at) AS first_at
        FROM buyback_photos p
        JOIN buyback_lines l ON l.id = p.line_id
        JOIN buyback_batches b ON b.id = l.batch_id
       GROUP BY b.request_id
    ),
    paid AS (
      -- Money OUT to the supplier, by the date on the settlement.
      SELECT d.request_id, SUM(st.amount) AS amount
        FROM settlement_transactions st
        JOIN buyback_deals d ON d.id = st.deal_id
       WHERE st.leg = 'DEALER'
         AND st.txn_date BETWEEN ${from}::date AND ${to}::date
       GROUP BY d.request_id
    ),
    buyback_leads AS (
      -- CRM leads of dealers with a buyback request (GSTIN match, owner.ts).
      SELECT DISTINCT m.dealer_lead_id
        FROM buyback_requests br
        JOIN accounts a ON a.id = br.dealer_entity_id
        JOIN ${dealerLeadByGstin(GSTIN_KEY(sql`a.gstin`))} m ON TRUE
       WHERE m.dealer_lead_id IS NOT NULL
    ),
    margin AS (
      -- Deals whose recycler sale was booked in the period: all that came in
      -- from the recycler minus all that went out to the dealer, on that deal.
      SELECT d.request_id,
             COALESCE(SUM(st.amount) FILTER (WHERE st.leg = 'VENDOR'), 0)
           - COALESCE(SUM(st.amount) FILTER (WHERE st.leg = 'DEALER'), 0) AS amount
        FROM buyback_deals d
        JOIN settlement_transactions st ON st.deal_id = d.id
       WHERE EXISTS (SELECT 1 FROM settlement_transactions v
                      WHERE v.deal_id = d.id AND v.leg = 'VENDOR'
                        AND v.txn_date BETWEEN ${from}::date AND ${to}::date)
       GROUP BY d.request_id
    ),
    parts AS (
      SELECT rs.spoc,
             1::bigint AS requests, 0::numeric AS kg, 0::bigint AS missing_weight,
             0::bigint AS pickups, 0::bigint AS images, 0::bigint AS accepted,
             0::bigint AS quotes, 0::numeric AS paid, 0::numeric AS margin,
             0::bigint AS margin_deals, 0::bigint AS dealers_called
        FROM received rc
        LEFT JOIN request_spoc rs ON rs.request_id = rc.request_id
      UNION ALL
      SELECT rs.spoc, 0, COALESCE(rk.kg, 0), COALESCE(rk.missing_weight, 0), 1, 0, 0, 0, 0, 0, 0, 0
        FROM picked pk
        LEFT JOIN request_spoc rs ON rs.request_id = pk.request_id
        LEFT JOIN request_kg rk ON rk.request_id = pk.request_id
      UNION ALL
      SELECT rs.spoc, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0
        FROM first_photo fp
        LEFT JOIN request_spoc rs ON rs.request_id = fp.request_id
       WHERE ${istRangeTz(sql`fp.first_at`, from, to)}
      UNION ALL
      SELECT rs.spoc, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0
        FROM accepted ac
        LEFT JOIN request_spoc rs ON rs.request_id = ac.request_id
      UNION ALL
      SELECT rs.spoc, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0
        FROM final_offers fo
        JOIN buyback_deals d ON d.id = fo.deal_id
        LEFT JOIN request_spoc rs ON rs.request_id = d.request_id
       WHERE fo.sent_at IS NOT NULL AND ${istRangeTz(sql`fo.sent_at`, from, to)}
      UNION ALL
      SELECT rs.spoc, 0, 0, 0, 0, 0, 0, 0, pd.amount, 0, 0, 0
        FROM paid pd
        LEFT JOIN request_spoc rs ON rs.request_id = pd.request_id
      UNION ALL
      SELECT rs.spoc, 0, 0, 0, 0, 0, 0, 0, 0, mg.amount, 1, 0
        FROM margin mg
        LEFT JOIN request_spoc rs ON rs.request_id = mg.request_id
      UNION ALL
      -- ID 59: human calls only, a NeoDove re-disposition counted once.
      -- ID 10: only calls on buyback leads.
      SELECT t.performed_by, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, COUNT(DISTINCT t.dealer_lead_id)
        FROM lead_touchpoints t
        JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
       WHERE ${humanCall()}
         AND t.performed_by IS NOT NULL
         AND ${istRangeTz(sql`t.performed_at`, from, to)}
         AND ((to_jsonb(dl) ->> 'business_type') = 'buyback'
              OR t.dealer_lead_id IN (SELECT dealer_lead_id FROM buyback_leads))
       GROUP BY t.performed_by
    ),
    summed AS (
      SELECT spoc,
             SUM(requests)       AS requests,
             SUM(kg)             AS kg,
             SUM(missing_weight) AS missing_weight,
             SUM(pickups)        AS pickups,
             SUM(images)         AS images,
             SUM(accepted)       AS accepted,
             SUM(quotes)         AS quotes,
             SUM(paid)           AS paid,
             SUM(margin)         AS margin,
             SUM(margin_deals)   AS margin_deals,
             SUM(dealers_called) AS dealers_called
        FROM parts
       GROUP BY spoc
    )
    SELECT s.spoc, u.name,
           s.requests::text AS requests, s.kg::text AS kg, s.missing_weight::text AS missing_weight,
           s.pickups::text AS pickups, s.images::text AS images, s.accepted::text AS accepted,
           s.quotes::text AS quotes, s.paid::text AS paid, s.margin::text AS margin,
           s.margin_deals::text AS margin_deals, s.dealers_called::text AS dealers_called
      FROM summed s
      LEFT JOIN users u ON u.id::text = s.spoc
     ORDER BY u.name NULLS LAST
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    spoc: r.spoc == null ? null : String(r.spoc),
    name: r.name == null ? null : String(r.name),
    requests: num(r.requests),
    images: num(r.images),
    quotes: num(r.quotes),
    accepted: num(r.accepted),
    pickups: num(r.pickups),
    kg: num(r.kg),
    missing_weight: num(r.missing_weight),
    paid: num(r.paid),
    // No recycler sale booked in the period → not measurable, not ₹0.
    margin: num(r.margin_deals) > 0 ? num(r.margin) : null,
    dealers_called: num(r.dealers_called),
  }));
}

/** Open requests per owner by where they are waiting, as of now (sheet 4, Block C). */
async function pipelineRows(): Promise<DigestTable["rows"]> {
  const { db } = await import("@/lib/db");
  const rows = (await db.execute(sql`
    WITH open_deals AS (
      SELECT br.owner_id, d.status::text AS status, d.updated_at,
             COALESCE(br.submitted_at, br.created_at) AS received_at,
             EXISTS (SELECT 1 FROM buyback_photos p
                       JOIN buyback_lines l ON l.id = p.line_id
                       JOIN buyback_batches b ON b.id = l.batch_id
                      WHERE b.request_id = br.id) AS has_photo,
             (SELECT MAX(fo.sent_at) FROM final_offers fo WHERE fo.deal_id = d.id) AS last_offer_at
        FROM buyback_requests br
        JOIN buyback_deals d ON d.request_id = br.id
       WHERE d.status NOT IN ('DRAFT', 'SETTLED', 'CLOSED', 'REJECTED', 'CANCELLED')
    )
    SELECT u.name,
           COUNT(*) FILTER (WHERE NOT o.has_photo
                              AND o.status IN ('SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUESTED'))::int AS awaiting_images,
           COUNT(*) FILTER (WHERE o.has_photo AND o.last_offer_at IS NULL
                              AND o.status IN ('SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUESTED',
                                               'NEGOTIATING', 'DEALER_REOPENED'))::int AS no_quote,
           COUNT(*) FILTER (WHERE o.status = 'FINAL_OFFER_SENT'
                              AND o.last_offer_at < now() - INTERVAL '2 days')::int AS no_reply,
           COUNT(*) FILTER (WHERE o.status IN ('DEALER_ACCEPTED', 'MARGIN_SET', 'VENDOR_ROUTED',
                                               'VENDOR_NEGOTIATING', 'VENDOR_AGREED', 'PO_EXCHANGED'))::int AS accepted,
           COUNT(*) FILTER (WHERE o.status = 'PICKUP_SCHEDULED')::int AS pickup,
           COUNT(*) FILTER (WHERE o.updated_at < now() - INTERVAL '3 days')::int AS aged,
           MAX(FLOOR(EXTRACT(EPOCH FROM (now() - o.received_at)) / 86400))::int AS oldest_days
      FROM open_deals o
      LEFT JOIN users u ON u.id::text = o.owner_id
     GROUP BY o.owner_id, u.name
     ORDER BY u.name NULLS LAST
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => [
    r.name == null ? UNASSIGNED : String(r.name),
    num(r.awaiting_images),
    num(r.no_quote),
    num(r.no_reply),
    num(r.accepted),
    num(r.pickup),
    num(r.aged),
    num(r.oldest_days),
  ]);
}

/** Open pickups per request SPOC for two IST days, with the kg expected on the first. */
async function pickupRows(today: string, tomorrow: string): Promise<DigestTable["rows"]> {
  const { db } = await import("@/lib/db");
  const rows = (await db.execute(sql`
    WITH open_pickups AS (
      SELECT br.owner_id, p.scheduled_at,
             -- The lines this pickup covers: its own batch, or the whole request.
             (SELECT COALESCE(SUM(l.quantity * l.unit_weight_kg), 0)
                FROM buyback_batches b
                JOIN buyback_lines l ON l.batch_id = b.id
               WHERE b.request_id = d.request_id
                 AND (p.batch_id IS NULL OR b.id = p.batch_id)) AS kg
        FROM pickups p
        JOIN buyback_deals d ON d.id = p.deal_id
        JOIN buyback_requests br ON br.id = d.request_id
       WHERE p.completed_at IS NULL
         AND ${istRangeTz(sql`p.scheduled_at`, today, tomorrow)}
    )
    SELECT u.name,
           COUNT(*) FILTER (WHERE ${istRangeTz(sql`o.scheduled_at`, today, today)})::int       AS today,
           COUNT(*) FILTER (WHERE ${istRangeTz(sql`o.scheduled_at`, tomorrow, tomorrow)})::int AS tomorrow,
           COALESCE(SUM(o.kg) FILTER (WHERE ${istRangeTz(sql`o.scheduled_at`, today, today)}), 0)::text AS kg_today
      FROM open_pickups o
      LEFT JOIN users u ON u.id::text = o.owner_id
     GROUP BY o.owner_id, u.name
     ORDER BY u.name NULLS LAST
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => [
    r.name == null ? UNASSIGNED : String(r.name),
    num(r.today),
    num(r.tomorrow),
    Math.round(num(r.kg_today) * 10) / 10,
  ]);
}

type Targets = { byUser: Map<string, number>; company: number | null; note: string };

/**
 * MTD targets for "Scrap deals" (= quotes accepted), pro-rated over working
 * days exactly as the Sales Daily mail and the targets page do. It is the only
 * buyback metric in the targets register (src/lib/targets/rules.ts). A database
 * without the register (E-303) simply has no targets.
 */
async function scrapDealTargets(monthFirst: string, upTo: string): Promise<Targets> {
  const none = (note: string): Targets => ({ byUser: new Map(), company: null, note });
  try {
    const { db } = await import("@/lib/db");
    const hol = (await db.execute(sql`
      SELECT holiday_date::text AS d FROM holiday_calendar
       WHERE is_active IS NOT FALSE AND holiday_date BETWEEN ${monthFirst}::date AND ${monthEnd(monthFirst)}::date
    `)) as unknown as Array<{ d: string }>;
    const holidays = new Set(hol.map((h) => h.d));
    const total = workingDaysBetween(monthFirst, monthEnd(monthFirst), holidays);
    const elapsed = workingDaysBetween(monthFirst, upTo, holidays);
    const rows = (await db.execute(sql`
      SELECT user_id, SUM(ceo_target + admin_addon)::float8 AS monthly
        FROM sales_targets
       WHERE month = ${monthFirst}::date AND metric = 'scrap_deals' AND status IN ('pushed', 'accepted')
       GROUP BY user_id
    `)) as unknown as Array<{ user_id: string; monthly: number }>;
    if (rows.length === 0 || total <= 0) {
      return none("No buyback targets are set for this month, so the target cells read “—”.");
    }
    const byUser = new Map<string, number>();
    for (const r of rows) byUser.set(String(r.user_id), (num(r.monthly) * elapsed) / total);
    const company = [...byUser.values()].reduce((a, b) => a + b, 0);
    return {
      byUser,
      company,
      note:
        `Targets: the only buyback target in the register is Scrap deals, shown against Quotes accepted ` +
        `(${rows.length} ${rows.length === 1 ? "person" : "people"} this month). Month to date is ${elapsed} of ` +
        `${total} working days, so it is ${elapsed}/${total} of the monthly target. Other rows have no target yet.`,
    };
  } catch {
    return none("Targets are not available on this database, so the target cells read “—”.");
  }
}

async function collect(
  istDay: string,
): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    const sendDay = addDays(istDay, 1);
    const dayAfter = addDays(istDay, 2);
    const monthFirst = firstOfMonth(istDay);
    const lm = sameSpanLastMonth(istDay);
    const [yesterday, last7, mtd, lastMonth, pipeline, pickups, targets] = await Promise.all([
      periodRows(istDay, istDay),
      periodRows(addDays(istDay, -6), istDay),
      periodRows(monthFirst, istDay),
      periodRows(lm.from, lm.to),
      pipelineRows(),
      pickupRows(sendDay, dayAfter),
      scrapDealTargets(monthFirst, istDay),
    ]);

    const company = {
      y: sumFigures(yesterday),
      d7: sumFigures(last7),
      mtd: sumFigures(mtd),
      lm: sumFigures(lastMonth),
    };
    const buybackOnly = (rows: BuybackSpocRow[]) => rows.filter(hasBuybackFigure);

    return {
      ok: true,
      figures: {
        activity: [],
        headline: [buybackHeadline(company.y)],
        wide: true,
        backlog: [],
        tables: [
          {
            key: "company",
            title: "A · Company headline",
            columns: BLOCK_A_COLUMNS,
            rows: blockARows(company, targets.company),
            textColumns: 1,
            note: targets.note,
          },
          {
            key: "per_spoc",
            title: "B · Per SPOC",
            columns: BLOCK_B_COLUMNS,
            rows: blockBRows(
              { yesterday: buybackOnly(yesterday), last7: buybackOnly(last7), mtd: buybackOnly(mtd) },
              targets.byUser,
            ),
            note:
              "The SPOC is the request's owner. Dealers called counts the person's human calls on buyback " +
              "leads only: Type of Business = Buyback, or the CRM lead of a dealer with a buyback request (GSTIN match).",
            empty: "No buyback activity this month.",
          },
          {
            key: "pipeline",
            title: "C · Buyback pipeline — as of this morning",
            columns: [
              "SPOC",
              "Awaiting images",
              "Images in, quote not sent",
              "Quote sent, no reply > 2d",
              "Accepted, pickup not scheduled",
              "Pickup scheduled",
              "Aged > 3d in any stage",
              "Oldest open request (days)",
            ],
            rows: pipeline,
            textColumns: 1,
            note: "Aged > 3d: the request has not moved for three days (the deal's last update).",
            empty: "No open buyback requests.",
          },
          {
            key: "today",
            title: "D · Pickups today and tomorrow",
            columns: ["SPOC", "Pickups today", "Pickups tomorrow", "Expected kg today"],
            rows: pickups,
            textColumns: 1,
            empty: "No pickups scheduled for today or tomorrow.",
          },
        ],
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[digest:buyback_daily] build failed:", error);
    return { ok: false, figures: { activity: [], backlog: [] }, error };
  }
}

async function collectDetail(): Promise<{ ok: boolean; detail: DigestDetail; error?: string }> {
  return { ok: true, detail: {} };
}

export const buybackDailyDigest: DigestKindDescriptor = {
  id: "buyback_daily",
  label: "Buyback Daily",
  description:
    "One mail every morning: A · the company headline (requests, quotes, pickups, kg, ₹ paid, " +
    "₹/kg and gross margin — yesterday, last 7 days, month to date, target and the same period " +
    "last month), B · the same activity per SPOC (the request's owner), C · the open buyback " +
    "pipeline by where each request is waiting, and D · pickups for today and tomorrow with the " +
    "kg expected today. Nothing is sent until recipients are added here.",
  settingsKey: "buyback_daily_digest",
  settingsHref: "/admin/settings/buyback-daily",
  ctaHref: "/admin/buyback/dashboard",
  ctaLabel: "Open Buyback Dashboard",
  sections: SECTIONS,
  slots: ["morning"],
  defaults: { enabled: false, recipients: [] },
  subject: ({ dayLabel }) => `iTarang Buyback Daily — ${dayLabel}`,
  collect,
  collectDetail,
};
