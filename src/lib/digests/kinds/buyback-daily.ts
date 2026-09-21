/**
 * Buyback Daily digest (B9) — per SPOC: yesterday, month to date, last 7 days,
 * plus pickups scheduled today and tomorrow. Same shape and slot rules as the
 * Sales Daily mail (B8); reuses its table block.
 *
 * WHO THE SPOC IS. `buyback_requests.owner_id` (E-302, review R-12) — set at
 * creation from the dealer's CRM owner (GSTIN match) and by Claim / Assign on
 * the admin request page. Every figure about a request, quotes included, is
 * credited to that owner; a request nobody owns shows as "(unassigned)" so the
 * gap is visible rather than hidden. This replaced a guess — "the latest admin
 * to act on the request" — under which the Sales Head was 136 of 153 actions
 * and so owned almost everything.
 *
 * DEFINITIONS, per period [from, to] in IST, per SPOC:
 *   Battery sourced (kg)     Σ quantity × unit_weight_kg over the lines of every
 *                            request whose deal logged `complete_pickup` in the
 *                            period (`buyback_lines.unit_weight_kg` is already
 *                            kilograms; the ₹/unit column in LineInputTable is
 *                            price, not weight). Lines with no weight count 0
 *                            — so "Lines missing weight" sits beside kg (review
 *                            R-13): the under-count is shown, never silent.
 *                            New pickups can no longer complete without a
 *                            weight on every collected line.
 *   Count of dealers called  distinct dealer_lead_id on inside_sales_call /
 *                            ai_call touchpoints performed by the SPOC — the same
 *                            CRM call log the Sales Daily mail uses (NeoDove
 *                            calls count once the agent is linked, review R-03).
 *   Dealers who shared images  requests whose FIRST photo (MIN created_at over
 *                            every photo on every line of the request) fell in
 *                            the period — so a request counts once, never once
 *                            per photo.
 *   Converted                deals that logged `dealer_accept` in the period.
 *   Count of quotes shared   final_offers.sent_at in the period, credited to the
 *                            request's owner (not to whoever pressed Send).
 *
 * PIPELINE (as of now, one row per owner — replaces Hot / Cold / Warm, which
 * were copied from SALES leads and meant nothing for a scrap request):
 *   Under review             SUBMITTED, UNDER_REVIEW, INFO_REQUESTED
 *   Negotiating              NEGOTIATING, FINAL_OFFER_SENT, DEALER_REOPENED
 *   Accepted, no pickup yet  DEALER_ACCEPTED … PO_EXCHANGED (vendor leg)
 *   Pickup scheduled         PICKUP_SCHEDULED
 *   Picked up, settling      PICKED_UP, INVOICE_RAISED, INVOICE_APPROVED
 *   Scheduled today / tomorrow  `pickups.scheduled_at` on that IST day and not
 *                            yet completed.
 *
 * `db` is imported inside the queries, never at module scope — listing the
 * registry must not require DATABASE_URL (see kyc-review.ts).
 */

import { sql } from "drizzle-orm";

import { istRangeTz } from "../window";
import type {
  DigestDetail,
  DigestFigures,
  DigestKindDescriptor,
  DigestSection,
  DigestTable,
} from "../types";

const SECTIONS: DigestSection[] = [
  {
    key: "summary",
    label: "Headline",
    hint: "Kilograms sourced yesterday and quotes shared yesterday, one line at the top.",
    group: "activity",
  },
  {
    key: "yesterday",
    label: "Yesterday",
    hint: "Per SPOC (request owner): kg sourced, dealers called, dealers who shared images, converted, quotes.",
    group: "activity",
  },
  { key: "mtd", label: "Month to date", hint: "The same columns from the 1st of the month to yesterday.", group: "activity" },
  { key: "last7", label: "Last 7 days", hint: "The same columns over the seven days ending yesterday.", group: "activity" },
  {
    key: "pipeline",
    label: "Buyback pipeline",
    hint: "Per owner, once: open requests by stage as of this morning.",
    group: "backlog",
  },
  {
    key: "today",
    label: "Scheduled today",
    hint: "Pickups each SPOC has scheduled for today, and for tomorrow.",
    group: "backlog",
  },
];

const COLUMNS = [
  "Period",
  "Name of SPOC",
  "Battery sourced (kg)",
  "Lines missing weight",
  "Count of dealers called",
  "Dealers who shared images",
  "Converted",
  "Count of quotes shared",
];

const UNASSIGNED = "(unassigned)";

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const firstOfMonth = (iso: string) => `${iso.slice(0, 7)}-01`;
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

type PeriodRow = {
  spoc: string | null;
  name: string | null;
  kg: number;
  missing_weight: number;
  dealers_called: number;
  photo_requests: number;
  converted: number;
  quotes: number;
};

/**
 * One row per SPOC for one period. Every figure is grouped on its own natural
 * key first (request → SPOC, offer → sender, touchpoint → performer, lead →
 * owner) and the groups are unioned and summed, so a SPOC with only quotes
 * still appears.
 */
async function periodRows(from: string, to: string): Promise<PeriodRow[]> {
  const { db } = await import("@/lib/db");
  const rows = (await db.execute(sql`
    WITH request_spoc AS (
      -- The request's owner (E-302). NULL = unassigned.
      SELECT br.id AS request_id, br.owner_id AS spoc FROM buyback_requests br
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
    parts AS (
      SELECT rs.spoc, rk.kg AS kg, COALESCE(rk.missing_weight, 0)::bigint AS missing_weight,
             0::bigint AS dealers_called, 0::bigint AS photo_requests,
             0::bigint AS converted, 0::bigint AS quotes
        FROM picked pk
        LEFT JOIN request_spoc rs ON rs.request_id = pk.request_id
        LEFT JOIN request_kg rk ON rk.request_id = pk.request_id
      UNION ALL
      SELECT rs.spoc, 0, 0, 0, 1, 0, 0
        FROM first_photo fp
        LEFT JOIN request_spoc rs ON rs.request_id = fp.request_id
       WHERE ${istRangeTz(sql`fp.first_at`, from, to)}
      UNION ALL
      SELECT rs.spoc, 0, 0, 0, 0, 1, 0
        FROM accepted ac
        LEFT JOIN request_spoc rs ON rs.request_id = ac.request_id
      UNION ALL
      SELECT rs.spoc, 0, 0, 0, 0, 0, 1
        FROM final_offers fo
        JOIN buyback_deals d ON d.id = fo.deal_id
        LEFT JOIN request_spoc rs ON rs.request_id = d.request_id
       WHERE fo.sent_at IS NOT NULL AND ${istRangeTz(sql`fo.sent_at`, from, to)}
      UNION ALL
      SELECT t.performed_by, 0, 0, COUNT(DISTINCT t.dealer_lead_id), 0, 0, 0
        FROM lead_touchpoints t
       WHERE t.touchpoint_type IN ('inside_sales_call', 'ai_call')
         AND t.performed_by IS NOT NULL
         AND ${istRangeTz(sql`t.performed_at`, from, to)}
       GROUP BY t.performed_by
    ),
    summed AS (
      SELECT spoc,
             SUM(kg)::numeric        AS kg,
             SUM(missing_weight)     AS missing_weight,
             SUM(dealers_called)     AS dealers_called,
             SUM(photo_requests)     AS photo_requests,
             SUM(converted)          AS converted,
             SUM(quotes)             AS quotes
        FROM parts
       GROUP BY spoc
    )
    SELECT s.spoc, u.name, s.kg::text AS kg, s.missing_weight::text AS missing_weight,
           s.dealers_called::text AS dealers_called,
           s.photo_requests::text AS photo_requests,
           s.converted::text AS converted, s.quotes::text AS quotes
      FROM summed s
      LEFT JOIN users u ON u.id::text = s.spoc
     -- A SPOC whose only figures are the CRM-wide lead / call counts is noise
     -- in a buyback mail: keep rows that have at least one BUYBACK figure.
     WHERE s.kg > 0 OR s.missing_weight > 0 OR s.photo_requests > 0 OR s.converted > 0 OR s.quotes > 0
     ORDER BY u.name NULLS LAST
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    spoc: r.spoc == null ? null : String(r.spoc),
    name: r.name == null ? null : String(r.name),
    kg: num(r.kg),
    missing_weight: num(r.missing_weight),
    dealers_called: num(r.dealers_called),
    photo_requests: num(r.photo_requests),
    converted: num(r.converted),
    quotes: num(r.quotes),
  }));
}

type Scheduled = { name: string | null; today: number; tomorrow: number };

/**
 * Open requests per owner, by stage, as of now (review R-12 — replaces the
 * Hot / Cold / Warm columns that were copied from sales leads).
 */
async function pipelineRows(): Promise<DigestTable["rows"]> {
  const { db } = await import("@/lib/db");
  const rows = (await db.execute(sql`
    SELECT u.name,
           COUNT(*) FILTER (WHERE d.status IN ('SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUESTED'))::int AS review,
           COUNT(*) FILTER (WHERE d.status IN ('NEGOTIATING', 'FINAL_OFFER_SENT', 'DEALER_REOPENED'))::int AS negotiating,
           COUNT(*) FILTER (WHERE d.status IN ('DEALER_ACCEPTED', 'MARGIN_SET', 'VENDOR_ROUTED',
                                              'VENDOR_NEGOTIATING', 'VENDOR_AGREED', 'PO_EXCHANGED'))::int AS accepted,
           COUNT(*) FILTER (WHERE d.status = 'PICKUP_SCHEDULED')::int AS pickup,
           COUNT(*) FILTER (WHERE d.status IN ('PICKED_UP', 'INVOICE_RAISED', 'INVOICE_APPROVED'))::int AS settling
      FROM buyback_requests br
      JOIN buyback_deals d ON d.request_id = br.id
      LEFT JOIN users u ON u.id::text = br.owner_id
     WHERE d.status NOT IN ('DRAFT', 'SETTLED', 'CLOSED', 'REJECTED', 'CANCELLED')
     GROUP BY br.owner_id, u.name
     ORDER BY u.name NULLS LAST
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => [
    r.name == null ? UNASSIGNED : String(r.name),
    num(r.review),
    num(r.negotiating),
    num(r.accepted),
    num(r.pickup),
    num(r.settling),
  ]);
}

/** Open pickups per request SPOC for two IST days. */
async function scheduledPerSpoc(today: string, tomorrow: string): Promise<Map<string, Scheduled>> {
  const { db } = await import("@/lib/db");
  const rows = (await db.execute(sql`
    WITH request_spoc AS (
      SELECT br.id AS request_id, br.owner_id AS spoc FROM buyback_requests br
    )
    SELECT COALESCE(rs.spoc, '') AS spoc, u.name,
           COUNT(*) FILTER (WHERE ${istRangeTz(sql`p.scheduled_at`, today, today)})::int    AS today,
           COUNT(*) FILTER (WHERE ${istRangeTz(sql`p.scheduled_at`, tomorrow, tomorrow)})::int AS tomorrow
      FROM pickups p
      JOIN buyback_deals d ON d.id = p.deal_id
      LEFT JOIN request_spoc rs ON rs.request_id = d.request_id
      LEFT JOIN users u ON u.id::text = rs.spoc
     WHERE p.completed_at IS NULL
       AND ${istRangeTz(sql`p.scheduled_at`, today, tomorrow)}
     GROUP BY rs.spoc, u.name
  `)) as unknown as Array<{ spoc: string; name: string | null; today: number; tomorrow: number }>;
  const out = new Map<string, Scheduled>();
  for (const r of rows) out.set(r.spoc, { name: r.name, today: num(r.today), tomorrow: num(r.tomorrow) });
  return out;
}

// Pickups scheduled tomorrow used to be a column here, repeated identically in
// every period (review R-23); it lives only in the "Scheduled today" table.
function toTableRows(period: string, rows: PeriodRow[]): DigestTable["rows"] {
  return rows.map((r) => [
    period,
    r.name ?? UNASSIGNED,
    Math.round(r.kg * 10) / 10,
    r.missing_weight,
    r.dealers_called,
    r.photo_requests,
    r.converted,
    r.quotes,
  ]);
}

async function collect(
  istDay: string,
): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    const sendDay = addDays(istDay, 1);
    const dayAfter = addDays(istDay, 2);
    const [yesterday, mtd, last7, sched, pipeline] = await Promise.all([
      periodRows(istDay, istDay),
      periodRows(firstOfMonth(istDay), istDay),
      periodRows(addDays(istDay, -6), istDay),
      scheduledPerSpoc(sendDay, dayAfter),
      pipelineRows(),
    ]);

    const kgYesterday = yesterday.reduce((a, r) => a + r.kg, 0);
    const missingYesterday = yesterday.reduce((a, r) => a + r.missing_weight, 0);
    const quotesYesterday = yesterday.reduce((a, r) => a + r.quotes, 0);

    const todayRows: DigestTable["rows"] = [...sched.entries()]
      .filter(([, s]) => s.today > 0 || s.tomorrow > 0)
      .map(([, s]) => [s.name ?? UNASSIGNED, s.today, s.tomorrow])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

    return {
      ok: true,
      figures: {
        activity: [
          {
            key: "summary",
            label: "Battery sourced yesterday (kg)",
            value: Math.round(kgYesterday * 10) / 10,
            // R-13 — never let an under-count read as the real number.
            display:
              `${(Math.round(kgYesterday * 10) / 10).toLocaleString("en-IN")} kg` +
              (missingYesterday > 0
                ? ` (+ ${missingYesterday} line${missingYesterday === 1 ? "" : "s"} with no weight, not counted)`
                : ""),
          },
          { key: "summary", label: "Quotes shared yesterday", value: quotesYesterday },
        ],
        backlog: [],
        tables: [
          { key: "yesterday", title: "Yesterday", columns: COLUMNS, rows: toTableRows("Yesterday", yesterday), empty: "No pickups, photos, quotes or acceptances yesterday." },
          { key: "mtd", title: "Month to date", columns: COLUMNS, rows: toTableRows("MTD", mtd), empty: "Nothing recorded so far this month." },
          { key: "last7", title: "Last 7 days", columns: COLUMNS, rows: toTableRows("Last 7 days", last7), empty: "Nothing recorded in the last seven days." },
          {
            key: "pipeline",
            title: "Buyback pipeline — as of this morning",
            columns: [
              "Owner",
              "Under review",
              "Negotiating",
              "Accepted, no pickup yet",
              "Pickup scheduled",
              "Picked up, settling",
            ],
            rows: pipeline,
            empty: "No open buyback requests.",
          },
          {
            key: "today",
            title: "Scheduled today",
            columns: ["Name of SPOC", "Pickups scheduled today", "Pickups scheduled tomorrow"],
            rows: todayRows,
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
    "One mail every morning, per SPOC (the request's owner): kilograms of batteries " +
    "sourced, dealers called, dealers who shared photos, deals accepted and quotes shared — " +
    "yesterday, month to date and over the last seven days — then the open buyback " +
    "pipeline by stage, and pickups scheduled for today and tomorrow. Nothing is sent " +
    "until recipients are added here.",
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
