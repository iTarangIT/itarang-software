/**
 * Sales Daily digest (B8) — per SPOC: yesterday, month to date, last 7 days,
 * and what is scheduled today and tomorrow.
 *
 * Every number comes from the B6 builder (src/lib/admin/salesDashboard.ts), run
 * once per period, so the mail and /admin/reports/sales-dashboard can never
 * disagree for the same day — the definition of done for this digest. The only
 * query of its own is the scheduled-visit count for today and tomorrow, which
 * the builder pins to Postgres' "today" and this mail needs relative to the
 * covered day.
 *
 * WHAT `istDay` MEANS HERE. The engine hands the morning slot YESTERDAY's date
 * (the covered day). So: Yesterday = [istDay, istDay]; MTD = [1st of istDay's
 * month, istDay]; Last 7 days = [istDay − 6, istDay]; Today = istDay + 1 (the
 * send day); Tomorrow = istDay + 2. This kind is morning-only (see `slots`), so
 * there is no "today so far" variant to get wrong.
 *
 * SHAPE. The three period tables share one column set: Period | Name of SPOC |
 * Unique visit count | Count of dealers called | New visit count | New Hot |
 * Hot → Converted | Converted | Quotes | Batteries | Revenue | KYC. Every
 * number in them responds to the period. Visits scheduled for tomorrow used to
 * be a column too, repeated identically in all three periods (review R-23 — a
 * forward-looking number has no period); it lives only in the "Scheduled
 * today" table now, beside today's.
 *
 * Hot / Warm / Cold used to sit in those rows too — but they are open-lead
 * counts as of NOW, so Yesterday, MTD and Last 7 days showed identical numbers
 * and read as though nothing had moved (review R-09). They now have their own
 * table, "Open pipeline — as of this morning", shown once, one row per SPOC,
 * with how many of the Hot leads have held that rating for more than a week.
 * The period rows show MOVEMENT instead: leads that became Hot in the period,
 * and Hot leads that converted in it (definitions in salesDashboard.ts,
 * queryTotals). A final small table lists today's scheduled visits per SPOC.
 *
 * DEFINITIONS (all from the builder; see its header for the rep columns):
 *   unique visits    distinct dealers with a visit in the period (lead_visits.asm_id)
 *   dealers called   distinct dealer_lead_id on inside_sales_call / ai_call
 *                    touchpoints performed by the SPOC in the period.
 *                    NeoDove (CC) calls count for the rep once an admin maps
 *                    the NeoDove agent to their CRM user (review R-03,
 *                    /leads/neodove-campaigns/agents); unmapped agents' calls
 *                    carry no performer and appear on nobody's row.
 *   new visits       dealers whose first-ever visit fell in the period
 *   converted        leads that reached Converted in the period, keyed on
 *                    closing_owner_id — the same rule as the dashboard and every
 *                    report (M15). The AI dialer's 'qualified' current_status
 *                    is an intent rating, never counted as converted.
 *   new hot          leads whose rating became Hot in the period and are still
 *                    Hot (interest_changed_at, E-301), keyed on current owner
 *   hot → converted  of `converted`, those rated Hot when they closed
 *   quotes / batteries / revenue / KYC   the builder's Section O (review
 *                    R-10). Batteries, revenue and KYC reach a SPOC only via
 *                    the dealer's GSTIN on a CRM lead (gstinMatch.ts).
 *
 * `db` is imported inside the query, never at module scope — the registry lists
 * every kind, and listing must not require DATABASE_URL (see kyc-review.ts).
 */

import { sql } from "drizzle-orm";

import type { SalesDashboard, SalesSpocBlock } from "@/lib/admin/salesDashboardTypes";
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
    hint: "Total visits yesterday, new hot leads yesterday and total open hot leads, at the top.",
    group: "activity",
  },
  {
    key: "yesterday",
    label: "Yesterday",
    hint: "Per SPOC: unique visits, dealers called, new visits, new hot, hot → converted, converted, quotes, batteries, revenue, KYC.",
    group: "activity",
  },
  {
    key: "mtd",
    label: "Month to date",
    hint: "The same columns from the 1st of the month to yesterday.",
    group: "activity",
  },
  {
    key: "last7",
    label: "Last 7 days",
    hint: "The same columns over the seven days ending yesterday.",
    group: "activity",
  },
  {
    key: "pipeline",
    label: "Open pipeline",
    hint: "Per SPOC, once: open hot / warm / cold leads as of this morning, and hot leads rated more than 7 days ago.",
    group: "backlog",
  },
  {
    key: "today",
    label: "Scheduled today",
    hint: "Visits each SPOC has on the calendar for today, and for tomorrow.",
    group: "backlog",
  },
];

const COLUMNS = [
  "Period",
  "Name of SPOC",
  "Unique visit count",
  "Count of dealers called",
  "New visit count",
  "New Hot",
  "Hot → Converted",
  "Converted",
  "Quotes issued",
  "Batteries to dealers",
  "Revenue ₹",
  "KYC submitted",
];

// ─────────────────────────────── dates ──────────────────────────────────────

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function firstOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

// ─────────────────────────────── helpers ────────────────────────────────────

type Scheduled = { today: number; tomorrow: number };

/**
 * Open scheduled visits per ASM for two calendar days. The builder's snapshot
 * counts these against Postgres' own "today", which is right for a live screen
 * and wrong for a mail about a named day.
 */
async function scheduledPerSpoc(
  today: string,
  tomorrow: string,
): Promise<Map<string, Scheduled>> {
  const { db } = await import("@/lib/db");
  const rows = (await db.execute(sql`
    SELECT v.asm_id::text AS spoc,
           COUNT(*) FILTER (WHERE v.scheduled_date = ${today}::date)::int    AS today,
           COUNT(*) FILTER (WHERE v.scheduled_date = ${tomorrow}::date)::int AS tomorrow
      FROM lead_visits v
     WHERE v.asm_id IS NOT NULL
       AND v.scheduled_date IN (${today}::date, ${tomorrow}::date)
       AND v.visit_status NOT IN ('visited', 'cancelled', 'no_show')
     GROUP BY v.asm_id
  `)) as unknown as Array<{ spoc: string; today: number; tomorrow: number }>;
  const out = new Map<string, Scheduled>();
  for (const r of rows) out.set(r.spoc, { today: Number(r.today), tomorrow: Number(r.tomorrow) });
  return out;
}

function level(b: SalesSpocBlock, l: "hot" | "warm" | "cold"): number {
  return b.interest.rows.find((r) => r.interest_level === l)?.total ?? 0;
}

/** Hot leads whose rating is more than 7 days old (interest_changed_at, E-301). */
function hotOverAWeek(b: SalesSpocBlock): number {
  const r = b.interest.rows.find((x) => x.interest_level === "hot");
  return r ? r.age_8_14 + r.age_15_30 + r.age_30_plus : 0;
}

/**
 * The as-of-now position, one row per SPOC holding any open rated lead. Built
 * from ONE builder run: the interest section ignores the date range, so which
 * period's run it comes from does not matter.
 */
function pipelineRows(d: SalesDashboard): DigestTable["rows"] {
  return (d.per_spoc ?? [])
    .filter((b) => level(b, "hot") + level(b, "warm") + level(b, "cold") > 0)
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
    .map((b) => [
      b.name ?? "(unknown user)",
      level(b, "hot"),
      level(b, "warm"),
      level(b, "cold"),
      hotOverAWeek(b),
    ]);
}

/** One table row per SPOC for one period. Sorted by name so the mail is scannable. */
function periodRows(
  period: string,
  d: SalesDashboard,
): DigestTable["rows"] {
  return (d.per_spoc ?? [])
    .slice()
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
    .map((b) => [
      period,
      b.name ?? "(unknown user)",
      b.totals.unique_visits,
      b.totals.dealers_called,
      b.totals.new_visits,
      b.totals.new_hot,
      b.totals.hot_converted,
      b.totals.converted,
      b.outcome.quotes_issued,
      b.outcome.batteries_to_dealers,
      Math.round(b.outcome.revenue),
      b.outcome.kyc_submitted,
    ]);
}

// ─────────────────────────────── collect ────────────────────────────────────

async function collect(
  istDay: string,
): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    const { buildSalesDashboard } = await import("@/lib/admin/salesDashboard");
    const sendDay = addDays(istDay, 1);
    const dayAfter = addDays(istDay, 2);

    const [yesterday, mtd, last7, scheduled] = await Promise.all([
      buildSalesDashboard({ from: istDay, to: istDay, granularity: "day" }),
      buildSalesDashboard({ from: firstOfMonth(istDay), to: istDay, granularity: "day" }),
      buildSalesDashboard({ from: addDays(istDay, -6), to: istDay, granularity: "day" }),
      scheduledPerSpoc(sendDay, dayAfter),
    ]);

    // Today's table: every SPOC with something on the calendar, named via the
    // builder's per-rep blocks when they appear there, else by id.
    const names = new Map<string, string>();
    for (const d of [yesterday, mtd, last7]) {
      for (const b of d.per_spoc ?? []) names.set(b.spoc_id, b.name ?? b.spoc_id);
    }
    const missing = [...scheduled.keys()].filter((id) => !names.has(id));
    if (missing.length) {
      const { db } = await import("@/lib/db");
      const rows = (await db.execute(sql`
        SELECT id::text AS id, name FROM users
         WHERE id::text IN (${sql.join(missing.map((m) => sql`${m}`), sql`, `)})
      `)) as unknown as Array<{ id: string; name: string | null }>;
      for (const r of rows) names.set(r.id, r.name ?? r.id);
    }
    const todayRows: DigestTable["rows"] = [...scheduled.entries()]
      .filter(([, s]) => s.today > 0 || s.tomorrow > 0)
      .map(([id, s]) => [names.get(id) ?? id, s.today, s.tomorrow])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

    const hotTotal = yesterday.interest.rows.find((r) => r.interest_level === "hot")?.total ?? 0;

    return {
      ok: true,
      figures: {
        // The one-line headline the spec asks for. Kept as activity lines so the
        // ledger's `counts` blob and the Excel Figures sheet carry them too.
        activity: [
          { key: "summary", label: "Visits yesterday", value: yesterday.totals.visits },
          { key: "summary", label: "New hot leads yesterday", value: yesterday.totals.new_hot },
          { key: "summary", label: "Hot leads open", value: hotTotal },
        ],
        backlog: [],
        tables: [
          {
            key: "yesterday",
            title: "Yesterday",
            columns: COLUMNS,
            rows: periodRows("Yesterday", yesterday),
            empty: "No visits, calls or conversions yesterday.",
          },
          {
            key: "mtd",
            title: "Month to date",
            columns: COLUMNS,
            rows: periodRows("MTD", mtd),
            empty: "Nothing recorded so far this month.",
          },
          {
            key: "last7",
            title: "Last 7 days",
            columns: COLUMNS,
            rows: periodRows("Last 7 days", last7),
            empty: "Nothing recorded in the last seven days.",
          },
          {
            key: "pipeline",
            title: "Open pipeline — as of this morning",
            columns: ["Name of SPOC", "Hot", "Warm", "Cold", "Hot, rated 8+ days ago"],
            rows: pipelineRows(yesterday),
            empty: "No open hot, warm or cold leads.",
          },
          {
            key: "today",
            title: "Scheduled today",
            columns: ["Name of SPOC", "Scheduled visits today", "Scheduled visits tomorrow"],
            rows: todayRows,
            empty: "No visits scheduled for today or tomorrow.",
          },
        ],
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[digest:sales_daily] build failed:", error);
    return { ok: false, figures: { activity: [], backlog: [] }, error };
  }
}

/** The tables ARE the detail; there is no per-row list to expand. */
async function collectDetail(): Promise<{ ok: boolean; detail: DigestDetail; error?: string }> {
  return { ok: true, detail: {} };
}

export const salesDailyDigest: DigestKindDescriptor = {
  id: "sales_daily",
  label: "Sales Daily",
  description:
    "One mail every morning, per SPOC: what happened yesterday, month to date and over " +
    "the last seven days — unique visits, dealers called, new visits, new hot leads, hot " +
    "leads converted and conversions — then the open hot / warm / cold pipeline as of " +
    "this morning, and the visits scheduled for today and tomorrow. Nothing is " +
    "sent until recipients are added here.",
  settingsKey: "sales_daily_digest",
  settingsHref: "/admin/settings/sales-daily",
  ctaHref: "/admin/reports/sales-dashboard",
  ctaLabel: "Open Sales Dashboard",
  sections: SECTIONS,
  // Morning only: the report is about complete days, and an evening "today so
  // far" cut of MTD / last-7 would be neither.
  slots: ["morning"],
  // Ships OFF with no recipients — the spec's "nothing sends until set".
  defaults: { enabled: false, recipients: [] },
  subject: ({ dayLabel }) => `iTarang Sales Daily — ${dayLabel}`,
  collect,
  collectDetail,
};
