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
 * SHAPE. The three period tables share one column set, exactly as the CRM sheet
 * lists it: Period | Name of SPOC | Unique visit count | Count of dealers called |
 * New visit count | Hot | Cold | Warm | Converted | Count of scheduled visits
 * tomorrow. Hot / Cold / Warm are open-lead counts as of now, so they repeat
 * across periods by design. A fourth, smaller table lists today's scheduled
 * visits per SPOC.
 *
 * DEFINITIONS (all from the builder; see its header for the rep columns):
 *   unique visits    distinct dealers with a visit in the period (lead_visits.asm_id)
 *   dealers called   distinct dealer_lead_id on inside_sales_call / ai_call
 *                    touchpoints performed by the SPOC in the period.
 *                    CC-team calls will be included once the call-centre role
 *                    exists (ticket A2).
 *   new visits       dealers whose first-ever visit fell in the period
 *   converted        leads that reached Converted in the period, keyed on
 *                    closing_owner_id — the same rule as the dashboard, NOT the
 *                    legacy CONVERTED_STATUSES list in src/lib/admin/types.ts
 *                    (those are pre-lifecycle status names and would count nothing)
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
    hint: "Total visits yesterday and total open hot leads, one line at the top.",
    group: "activity",
  },
  {
    key: "yesterday",
    label: "Yesterday",
    hint: "Per SPOC: unique visits, dealers called, new visits, hot / cold / warm, converted.",
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
  "Hot",
  "Cold",
  "Warm",
  "Converted",
  "Count of scheduled visits tomorrow",
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

/** One table row per SPOC for one period. Sorted by name so the mail is scannable. */
function periodRows(
  period: string,
  d: SalesDashboard,
  scheduled: Map<string, Scheduled>,
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
      level(b, "hot"),
      level(b, "cold"),
      level(b, "warm"),
      b.totals.converted,
      scheduled.get(b.spoc_id)?.tomorrow ?? 0,
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
          { key: "summary", label: "Hot leads open", value: hotTotal },
        ],
        backlog: [],
        tables: [
          {
            key: "yesterday",
            title: "Yesterday",
            columns: COLUMNS,
            rows: periodRows("Yesterday", yesterday, scheduled),
            empty: "No visits, calls or conversions yesterday.",
          },
          {
            key: "mtd",
            title: "Month to date",
            columns: COLUMNS,
            rows: periodRows("MTD", mtd, scheduled),
            empty: "Nothing recorded so far this month.",
          },
          {
            key: "last7",
            title: "Last 7 days",
            columns: COLUMNS,
            rows: periodRows("Last 7 days", last7, scheduled),
            empty: "Nothing recorded in the last seven days.",
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
    "the last seven days — unique visits, dealers called, new visits, hot / cold / warm " +
    "and conversions — plus the visits scheduled for today and tomorrow. Nothing is " +
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
