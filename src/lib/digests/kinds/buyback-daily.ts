/**
 * Buyback Daily digest (B9) — per SPOC: yesterday, month to date, last 7 days,
 * plus pickups scheduled today and tomorrow. Same shape and slot rules as the
 * Sales Daily mail (B8); reuses its table block.
 *
 * WHO THE SPOC IS. Buyback requests carry no owner column — `created_by` is
 * the DEALER's user and `buyback_deals` has no assignee. What the module does
 * record is every admin-side action in `buyback_activity_log` (append-only,
 * role='admin' rows written in the same transaction as each transition), so a
 * request's SPOC is the LATEST admin actor on it. Anirudh (sales_head) is 136
 * of the 153 admin actions on sandbox; 12 system rows have no actor and fall
 * under "(unassigned)". Quotes are the one figure with a first-class owner —
 * `final_offers.sent_by` — and are attributed to that user directly.
 *
 * DEFINITIONS, per period [from, to] in IST, per SPOC:
 *   Battery sourced (kg)     Σ quantity × unit_weight_kg over the lines of every
 *                            request whose deal logged `complete_pickup` in the
 *                            period (`buyback_lines.unit_weight_kg` is already
 *                            kilograms; the ₹/unit column in LineInputTable is
 *                            price, not weight). Lines with no weight count 0.
 *   Count of dealers called  distinct dealer_lead_id on inside_sales_call /
 *                            ai_call touchpoints performed by the SPOC — the same
 *                            CRM call log the Sales Daily mail uses.
 *                            CC-team calls will be included once the call-centre
 *                            role exists (ticket A2).
 *   Dealers who shared images  requests whose FIRST photo (MIN created_at over
 *                            every photo on every line of the request) fell in
 *                            the period — so a request counts once, never once
 *                            per photo.
 *   Hot / Cold / Warm        A buyback request has NO link to a dealer lead on
 *                            sandbox (0 of 44 join through onboarding, dealer_id
 *                            or phone), so "interest level of the linked lead"
 *                            cannot be computed. The columns show the open leads
 *                            the SPOC currently owns by interest level — the
 *                            same figure as Sales Daily — and the mail's column
 *                            hint says so.
 *   Converted                deals that logged `dealer_accept` in the period.
 *   Count of quotes shared   final_offers.sent_at in the period, by sent_by.
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
    hint: "Per SPOC: kg sourced, dealers called, dealers who shared images, hot / cold / warm, converted, quotes.",
    group: "activity",
  },
  { key: "mtd", label: "Month to date", hint: "The same columns from the 1st of the month to yesterday.", group: "activity" },
  { key: "last7", label: "Last 7 days", hint: "The same columns over the seven days ending yesterday.", group: "activity" },
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
  "Count of dealers called",
  "Dealers who shared images",
  "Hot",
  "Cold",
  "Warm",
  "Converted",
  "Count of quotes shared",
  "Pickups scheduled tomorrow",
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
  dealers_called: number;
  photo_requests: number;
  hot: number;
  cold: number;
  warm: number;
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
      -- Latest admin actor on each request.
      SELECT DISTINCT ON (al.request_id) al.request_id, al.actor_id::text AS spoc
        FROM buyback_activity_log al
       WHERE al.role = 'admin' AND al.request_id IS NOT NULL
       ORDER BY al.request_id, al.created_at DESC
    ),
    request_kg AS (
      SELECT b.request_id, COALESCE(SUM(l.quantity * l.unit_weight_kg), 0) AS kg
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
      SELECT rs.spoc, rk.kg AS kg, 0::bigint AS dealers_called, 0::bigint AS photo_requests,
             0::bigint AS hot, 0::bigint AS cold, 0::bigint AS warm, 0::bigint AS converted, 0::bigint AS quotes
        FROM picked pk
        LEFT JOIN request_spoc rs ON rs.request_id = pk.request_id
        LEFT JOIN request_kg rk ON rk.request_id = pk.request_id
      UNION ALL
      SELECT rs.spoc, 0, 0, 1, 0, 0, 0, 0, 0
        FROM first_photo fp
        LEFT JOIN request_spoc rs ON rs.request_id = fp.request_id
       WHERE ${istRangeTz(sql`fp.first_at`, from, to)}
      UNION ALL
      SELECT rs.spoc, 0, 0, 0, 0, 0, 0, 1, 0
        FROM accepted ac
        LEFT JOIN request_spoc rs ON rs.request_id = ac.request_id
      UNION ALL
      SELECT fo.sent_by::text, 0, 0, 0, 0, 0, 0, 0, 1
        FROM final_offers fo
       WHERE fo.sent_at IS NOT NULL AND ${istRangeTz(sql`fo.sent_at`, from, to)}
      UNION ALL
      SELECT t.performed_by, 0, COUNT(DISTINCT t.dealer_lead_id), 0, 0, 0, 0, 0, 0
        FROM lead_touchpoints t
       WHERE t.touchpoint_type IN ('inside_sales_call', 'ai_call')
         AND t.performed_by IS NOT NULL
         AND ${istRangeTz(sql`t.performed_at`, from, to)}
       GROUP BY t.performed_by
      UNION ALL
      SELECT dl.current_owner_id, 0, 0, 0,
             COUNT(*) FILTER (WHERE dl.interest_level = 'hot'),
             COUNT(*) FILTER (WHERE dl.interest_level = 'cold'),
             COUNT(*) FILTER (WHERE dl.interest_level = 'warm'),
             0, 0
        FROM dealer_leads dl
       WHERE dl.interest_level IN ('hot', 'warm', 'cold')
         AND dl.current_owner_id IS NOT NULL
         AND dl.is_active IS NOT FALSE
         AND dl.lead_status IS DISTINCT FROM 'Converted' AND dl.lead_status IS DISTINCT FROM 'Lost'
       GROUP BY dl.current_owner_id
    ),
    summed AS (
      SELECT spoc,
             SUM(kg)::numeric        AS kg,
             SUM(dealers_called)     AS dealers_called,
             SUM(photo_requests)     AS photo_requests,
             SUM(hot) AS hot, SUM(cold) AS cold, SUM(warm) AS warm,
             SUM(converted)          AS converted,
             SUM(quotes)             AS quotes
        FROM parts
       GROUP BY spoc
    )
    SELECT s.spoc, u.name, s.kg::text AS kg, s.dealers_called::text AS dealers_called,
           s.photo_requests::text AS photo_requests, s.hot::text AS hot, s.cold::text AS cold,
           s.warm::text AS warm, s.converted::text AS converted, s.quotes::text AS quotes
      FROM summed s
      LEFT JOIN users u ON u.id::text = s.spoc
     -- A SPOC whose only figures are the CRM-wide lead / call counts is noise
     -- in a buyback mail: keep rows that have at least one BUYBACK figure.
     WHERE s.kg > 0 OR s.photo_requests > 0 OR s.converted > 0 OR s.quotes > 0
     ORDER BY u.name NULLS LAST
  `)) as unknown as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    spoc: r.spoc == null ? null : String(r.spoc),
    name: r.name == null ? null : String(r.name),
    kg: num(r.kg),
    dealers_called: num(r.dealers_called),
    photo_requests: num(r.photo_requests),
    hot: num(r.hot),
    cold: num(r.cold),
    warm: num(r.warm),
    converted: num(r.converted),
    quotes: num(r.quotes),
  }));
}

type Scheduled = { name: string | null; today: number; tomorrow: number };

/** Open pickups per request SPOC for two IST days. */
async function scheduledPerSpoc(today: string, tomorrow: string): Promise<Map<string, Scheduled>> {
  const { db } = await import("@/lib/db");
  const rows = (await db.execute(sql`
    WITH request_spoc AS (
      SELECT DISTINCT ON (al.request_id) al.request_id, al.actor_id::text AS spoc
        FROM buyback_activity_log al
       WHERE al.role = 'admin' AND al.request_id IS NOT NULL
       ORDER BY al.request_id, al.created_at DESC
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

function toTableRows(period: string, rows: PeriodRow[], sched: Map<string, Scheduled>): DigestTable["rows"] {
  return rows.map((r) => [
    period,
    r.name ?? UNASSIGNED,
    Math.round(r.kg * 10) / 10,
    r.dealers_called,
    r.photo_requests,
    r.hot,
    r.cold,
    r.warm,
    r.converted,
    r.quotes,
    sched.get(r.spoc ?? "")?.tomorrow ?? 0,
  ]);
}

async function collect(
  istDay: string,
): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    const sendDay = addDays(istDay, 1);
    const dayAfter = addDays(istDay, 2);
    const [yesterday, mtd, last7, sched] = await Promise.all([
      periodRows(istDay, istDay),
      periodRows(firstOfMonth(istDay), istDay),
      periodRows(addDays(istDay, -6), istDay),
      scheduledPerSpoc(sendDay, dayAfter),
    ]);

    const kgYesterday = yesterday.reduce((a, r) => a + r.kg, 0);
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
            display: `${(Math.round(kgYesterday * 10) / 10).toLocaleString("en-IN")} kg`,
          },
          { key: "summary", label: "Quotes shared yesterday", value: quotesYesterday },
        ],
        backlog: [],
        tables: [
          { key: "yesterday", title: "Yesterday", columns: COLUMNS, rows: toTableRows("Yesterday", yesterday, sched), empty: "No pickups, photos, quotes or acceptances yesterday." },
          { key: "mtd", title: "Month to date", columns: COLUMNS, rows: toTableRows("MTD", mtd, sched), empty: "Nothing recorded so far this month." },
          { key: "last7", title: "Last 7 days", columns: COLUMNS, rows: toTableRows("Last 7 days", last7, sched), empty: "Nothing recorded in the last seven days." },
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
    "One mail every morning, per SPOC: kilograms of batteries sourced, dealers called, " +
    "dealers who shared photos, hot / cold / warm leads, deals accepted and quotes shared — " +
    "yesterday, month to date and over the last seven days — plus pickups scheduled for " +
    "today and tomorrow. Nothing is sent until recipients are added here.",
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
