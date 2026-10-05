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
 *   dealers called   distinct dealer_lead_id on HUMAN calls (inside_sales_call,
 *                    a NeoDove re-disposition counted once — humanCall(),
 *                    src/lib/reports/metricDefinitions.ts, ID 59); AI dialer
 *                    calls are not counted. Performed by the SPOC in the period.
 *                    NeoDove (CC) calls count for the rep once an admin maps
 *                    the NeoDove agent to their CRM user (review R-03,
 *                    /leads/neodove-campaigns/agents); unmapped agents' calls
 *                    carry no performer and appear on nobody's row.
 *   engaged /        Block C, per caller: engagedCall() and Hot AT THE MOMENT
 *   hot to field     of transfer (wasHotAt) — ID 59, metricDefinitions.ts;
 *                    counted in salesDailyBlocks.ts (loadRepExtras).
 *   new visits       dealers whose first-ever visit fell in the period
 *   converted        leads that reached Converted in the period, keyed on
 *                    closing_owner_id — the same rule as the dashboard and every
 *                    report (M15). The AI dialer's 'qualified' current_status
 *                    is an intent rating, never counted as converted.
 *   new hot          leads whose rating became Hot in the period and are still
 *                    Hot (interest_changed_at, E-301), keyed on current owner
 *   hot → converted  of `converted`, those rated Hot when they closed
 *   quotes           the FIRST quote per lead (revisions are not counted, ID 59)
 *   batteries / revenue / KYC   the builder's Section O (review
 *                    R-10). Batteries, revenue and KYC reach a SPOC only via
 *                    the dealer's GSTIN on a CRM lead (gstinMatch.ts).
 *
 * `db` is imported inside the query, never at module scope — the registry lists
 * every kind, and listing must not require DATABASE_URL (see kyc-review.ts).
 */

import { sql } from "drizzle-orm";

import {
  BLOCK_A_COLUMNS,
  BLOCK_A_PCT_COLUMN,
  blockAHeadline,
  blockATableRows,
  buildBlockA,
} from "../salesDailyBlockA";
import {
  BLOCK_D_COLUMNS,
  NO_OWNER_KEY,
  REP_BLOCK_COLUMNS,
  REP_BLOCK_PCT_COLUMN,
  blockDRows,
  buildRepBlocks,
  loadAwaitingFieldVisit,
  loadRepExtras,
  repBlockTableRows,
} from "../salesDailyBlocks";
import { formatSlotTime } from "../schedule";
import type {
  DigestDetail,
  DigestFigures,
  DigestKindDescriptor,
  DigestSection,
  DigestTable,
} from "../types";

// Daily Sales email v1.1 (tracker ID 9, handover P4-6; decided 26 / 29 Sep
// 2026). ONE management email — no personal emails to ASMs and ISRs, who see
// their own numbers on their performance pages. Sent at the morning slot time
// set on /admin/settings/sales-daily (default 09:00 IST); the "as of" labels
// below read that time, never a fixed one.
//   Headline   one line: yesterday's outcome and what is behind target.
//   A Company  22 rows × Yesterday · Last 7 days · MTD · MTD target · % of
//              target · same period last month · Δ (salesDailyBlockA.ts).
//   Right now  sales-ready leads with no owner and the oldest wait.
//   B Field team (ASM)          per ASM, Block A's field metrics: Yesterday,
//                               MTD, MTD target, % of target (salesDailyBlocks.ts).
//   C Inside sales (ISR / CC)   per ISR, Block A's calling metrics, same columns.
//   D Position this morning     open Hot / Warm / Cold per owner, awaiting
//                               field visit, and sales-ready leads with no owner.
//   E Today and tomorrow        scheduled visits and follow-ups per owner.
//   F Oldest overdue            the 10 oldest overdue items, by name and city — no phone numbers.
const SECTIONS: DigestSection[] = [
  { key: "summary", label: "Headline", hint: "One line: yesterday's outcome and what is behind target.", group: "activity" },
  { key: "block_a", label: "A · Company", hint: "22 metrics: yesterday, last 7 days, MTD, MTD target, % of target, same period last month, Δ.", group: "activity" },
  { key: "right_now", label: "Right now", hint: "Sales-ready leads with no owner, and the oldest wait.", group: "backlog" },
  { key: "block_b", label: "B · Field team (ASM)", hint: "Per ASM: visits, hot received, quotes, approvals, Won, converted, revenue — yesterday, MTD, MTD target, % of target.", group: "activity" },
  { key: "block_c", label: "C · Inside sales (ISR / CC)", hint: "Per ISR: calls, dealers called, engaged calls, hot handed to field, quotes, Won, converted — yesterday, MTD, MTD target, % of target.", group: "activity" },
  { key: "block_d", label: "D · Position this morning", hint: "Open Hot / Warm / Cold per owner, Hot rated 8+ days ago, awaiting field visit, and sales-ready leads with no owner — as of the send time.", group: "backlog" },
  { key: "block_e", label: "E · Today and tomorrow", hint: "Scheduled visits and follow-ups due, per owner.", group: "backlog" },
  { key: "block_f", label: "F · Oldest overdue", hint: "The 10 oldest overdue follow-ups and visits, by name.", group: "backlog" },
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

/** 1st of last month → the same day of last month (capped at its last day). */
function sameSpanLastMonth(iso: string): { from: string; to: string } {
  const d = new Date(`${iso}T00:00:00Z`);
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).getUTCDate();
  const to = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d.getUTCDate(), lastDay)));
  return { from: first.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
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

/**
 * Tracker ID 69 / P1-6: invoiced in each period but matched to no dealer — the
 * "₹X not matched to a dealer" line under Block A's Revenue. Same inclusive
 * invoice_date window as the Revenue row (salesDashboard queryOutcome), and
 * the same void-excluded rule, so Revenue + this = everything invoiced. A
 * period that fails is left unmeasured rather than failing the email.
 */
async function unmatchedRevenuePerPeriod(
  periods: Record<"yesterday" | "last7" | "mtd" | "lastMonth", { from: string; to: string }>,
): Promise<{ y: number | null; d7: number | null; mtd: number | null; lm: number | null }> {
  const { revenueSummary } = await import("@/lib/dashboard/revenueSource");
  const one = async (p: { from: string; to: string }): Promise<number | null> => {
    try {
      return (await revenueSummary({ from: p.from, to: p.to })).unlinked_total;
    } catch (e) {
      console.warn("[digest:sales_daily] unmatched revenue not measured:", e instanceof Error ? e.message : e);
      return null;
    }
  };
  const [y, d7, mtd, lm] = await Promise.all([
    one(periods.yesterday),
    one(periods.last7),
    one(periods.mtd),
    one(periods.lastMonth),
  ]);
  return { y, d7, mtd, lm };
}

async function rightNow(): Promise<{ waiting: number; oldestDays: number | null }> {
  try {
    // ID 82: the one "awaiting assignment" rule — the Ready to assign page
    // and the CEO card count the same leads. Imported here, not at module
    // scope: listing the digest kinds must not need DATABASE_URL.
    const { countAwaitingAssignment } = await import("@/lib/leads/salesReady");
    const c = await countAwaitingAssignment();
    return { waiting: c.total, oldestDays: c.oldestDays };
  } catch {
    return { waiting: 0, oldestDays: null };
  }
}

/** Block E: follow-ups due today / tomorrow per owner. */
async function followUpsPerOwner(today: string, tomorrow: string): Promise<Map<string, Scheduled>> {
  const { db } = await import("@/lib/db");
  const rows = (await db.execute(sql`
    SELECT dl.current_owner_id AS spoc,
           COUNT(*) FILTER (WHERE (dl.next_follow_up_at AT TIME ZONE 'Asia/Kolkata')::date = ${today}::date)::int AS today,
           COUNT(*) FILTER (WHERE (dl.next_follow_up_at AT TIME ZONE 'Asia/Kolkata')::date = ${tomorrow}::date)::int AS tomorrow
      FROM dealer_leads dl
     WHERE dl.current_owner_id IS NOT NULL
       AND dl.is_active IS NOT FALSE
       AND COALESCE(dl.lead_status, '') NOT IN ('Won', 'Converted', 'Lost')
       AND (dl.next_follow_up_at AT TIME ZONE 'Asia/Kolkata')::date IN (${today}::date, ${tomorrow}::date)
     GROUP BY dl.current_owner_id
  `)) as unknown as Array<{ spoc: string; today: number; tomorrow: number }>;
  return new Map(rows.map((r) => [r.spoc, { today: Number(r.today), tomorrow: Number(r.tomorrow) }]));
}

/** Block F: the 10 oldest overdue follow-ups and visits, by name and city — never a phone number. */
async function oldestOverdue(): Promise<DigestTable["rows"]> {
  const { db } = await import("@/lib/db");
  const rows = (await db.execute(sql`
    SELECT * FROM (
      SELECT COALESCE(dl.dealer_name, dl.shop_name, dl.id) AS dealer, dl.city AS city, u.name AS owner,
             'Follow-up' AS what, (dl.next_follow_up_at AT TIME ZONE 'Asia/Kolkata')::date AS due
        FROM dealer_leads dl
        LEFT JOIN users u ON u.id::text = dl.current_owner_id
       WHERE dl.next_follow_up_at < now() AND dl.is_active IS NOT FALSE
         AND COALESCE(dl.lead_status, '') NOT IN ('Won', 'Converted', 'Lost')
      UNION ALL
      SELECT COALESCE(dl.dealer_name, dl.shop_name, dl.id), dl.city, u.name, 'Visit', v.scheduled_date
        FROM lead_visits v
        JOIN dealer_leads dl ON dl.id = v.dealer_lead_id
        LEFT JOIN users u ON u.id::text = v.asm_id
       WHERE v.scheduled_date < (now() AT TIME ZONE 'Asia/Kolkata')::date
         AND v.visit_status IN ('scheduled', 'pending_scheduling')
         AND COALESCE(dl.lead_status, '') NOT IN ('Won', 'Converted', 'Lost')
    ) x
    ORDER BY due ASC
    LIMIT 10
  `)) as unknown as Array<{ dealer: string; city: string | null; owner: string | null; what: string; due: string }>;
  const today = new Date().toISOString().slice(0, 10);
  return rows.map((r) => {
    const due = String(r.due).slice(0, 10);
    const days = Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000));
    return [r.dealer, r.city?.trim() || "—", r.owner ?? "(no owner)", r.what, due, days];
  });
}

// ─────────────────────────────── collect ────────────────────────────────────

async function collect(
  istDay: string,
): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    const { buildSalesDashboard } = await import("@/lib/admin/salesDashboard");
    const { db } = await import("@/lib/db");
    const sendDay = addDays(istDay, 1);
    const dayAfter = addDays(istDay, 2);
    const periods = {
      yesterday: { from: istDay, to: istDay },
      last7: { from: addDays(istDay, -6), to: istDay },
      mtd: { from: firstOfMonth(istDay), to: istDay },
      lastMonth: sameSpanLastMonth(istDay),
    };

    const { getDigestSettings } = await import("../settings");
    const [yesterday, last7, mtd, lastMonth, scheduled, followUps, now, overdue, settings, extrasY, extrasMtd, awaiting, unmatched] = await Promise.all([
      buildSalesDashboard({ ...periods.yesterday, granularity: "day" }),
      buildSalesDashboard({ ...periods.last7, granularity: "day" }),
      buildSalesDashboard({ ...periods.mtd, granularity: "day" }),
      buildSalesDashboard({ ...periods.lastMonth, granularity: "day" }),
      scheduledPerSpoc(sendDay, dayAfter),
      followUpsPerOwner(sendDay, dayAfter),
      rightNow(),
      oldestOverdue(),
      getDigestSettings(salesDailyDigest),
      loadRepExtras(db as never, periods.yesterday),
      loadRepExtras(db as never, periods.mtd),
      loadAwaitingFieldVisit(db as never),
      unmatchedRevenuePerPeriod(periods),
    ]);
    const blockA = await buildBlockA(db as never, periods, { yesterday, last7, mtd, lastMonth }, unmatched);
    // The "as of" time is the configured morning send time (default 09:00).
    const asOf = formatSlotTime(settings.morningHour, settings.morningMinute);
    const extras = { y: extrasY, mtd: extrasMtd };

    // Names for Block E: the builder's per-rep blocks, then users for the rest.
    const names = new Map<string, string>();
    for (const d of [yesterday, mtd]) for (const b of d.per_spoc ?? []) names.set(b.spoc_id, b.name ?? b.spoc_id);
    const awaitingIds = [...(awaiting?.keys() ?? [])].filter((id) => id !== NO_OWNER_KEY);
    const missing = [...new Set([...scheduled.keys(), ...followUps.keys(), ...awaitingIds])].filter((id) => !names.has(id));
    if (missing.length) {
      const rows = (await db.execute(sql`
        SELECT id::text AS id, name FROM users
         WHERE id::text IN (${sql.join(missing.map((m) => sql`${m}`), sql`, `)})
      `)) as unknown as Array<{ id: string; name: string | null }>;
      for (const r of rows) names.set(r.id, r.name ?? r.id);
    }
    const eIds = [...new Set([...scheduled.keys(), ...followUps.keys()])];
    const todayRows: DigestTable["rows"] = eIds
      .map((id) => {
        const v = scheduled.get(id) ?? { today: 0, tomorrow: 0 };
        const f = followUps.get(id) ?? { today: 0, tomorrow: 0 };
        return [names.get(id) ?? id, v.today, f.today, v.tomorrow, f.tomorrow] as Array<string | number>;
      })
      .filter((r) => (r.slice(1) as number[]).some((n) => n > 0))
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

    return {
      ok: true,
      figures: {
        activity: [],
        headline: [blockAHeadline(blockA.rows)],
        wide: true,
        backlog: [],
        tables: [
          {
            key: "block_a",
            title: "A · Company",
            columns: BLOCK_A_COLUMNS,
            rows: blockATableRows(blockA.rows),
            textColumns: 1,
            groupHeaders: true,
            toneColumns: [BLOCK_A_PCT_COLUMN],
            note: blockA.targetsNote,
            // "Right now" sits right after the table, as in the mockup.
            footer: {
              key: "right_now",
              label: `Right now · ${asOf}`,
              items: [
                {
                  label: "Sales-ready, no owner",
                  value: `${now.waiting} lead${now.waiting === 1 ? "" : "s"}`,
                  hint: now.oldestDays != null ? `Oldest waiting ${now.oldestDays} days` : undefined,
                },
              ],
            },
          },
          {
            key: "block_b",
            title: "B · Field team (ASM)",
            columns: REP_BLOCK_COLUMNS,
            rows: repBlockTableRows(buildRepBlocks("asm", yesterday, mtd, extras, blockA.userTargets)),
            textColumns: 1,
            groupHeaders: true,
            toneColumns: [REP_BLOCK_PCT_COLUMN],
            note: "One block per ASM. MTD target and % of target only where the ASM has a target for that metric.",
            empty: "No ASMs on the Sales dashboard this month.",
          },
          {
            key: "block_c",
            title: "C · Inside sales (ISR / CC)",
            columns: REP_BLOCK_COLUMNS,
            rows: repBlockTableRows(buildRepBlocks("inside_sales_rep", yesterday, mtd, extras, blockA.userTargets)),
            textColumns: 1,
            groupHeaders: true,
            toneColumns: [REP_BLOCK_PCT_COLUMN],
            note: "One block per ISR / CC. MTD target and % of target only where the rep has a target for that metric.",
            empty: "No inside-sales reps on the Sales dashboard this month.",
          },
          {
            key: "block_d",
            title: `D · Position at ${asOf}`,
            columns: BLOCK_D_COLUMNS,
            rows: blockDRows(yesterday, awaiting ?? new Map(), names, now.waiting),
            textColumns: 1,
            note: awaiting
              ? "Awaiting field visit: transferred to an ASM and not yet visited. Sales-ready, no owner: on the (no owner) row."
              : "Awaiting field visit could not be measured on this database.",
            empty: "No open hot, warm or cold leads, and nothing awaiting a field visit.",
          },
          {
            key: "block_e",
            title: "E · Today and tomorrow",
            columns: ["Owner", "Visits today", "Follow-ups today", "Visits tomorrow", "Follow-ups tomorrow"],
            rows: todayRows,
            textColumns: 1,
            empty: "Nothing scheduled for today or tomorrow.",
          },
          {
            key: "block_f",
            title: "F · Oldest overdue",
            columns: ["Dealer", "City", "Owner", "What", "Was due", "Days overdue"],
            rows: overdue,
            textColumns: 5,
            empty: "Nothing overdue.",
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
    "Daily Sales email v1.1 — one management email every morning at the time set below " +
    "(default 09:00 IST): a one-line headline, " +
    "A · Company (22 metrics with MTD target, % of target and the same period last month), " +
    "sales-ready leads waiting for an owner, B · Field team, C · Inside sales, D · Position " +
    "as of the send time, E · Today and tomorrow, and F · the 10 oldest overdue items. No personal " +
    "emails to reps. Nothing is sent until recipients are added here.",
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
