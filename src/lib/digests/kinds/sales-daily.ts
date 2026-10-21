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
  blockAHeadlineParts,
  blockARowNotes,
  blockATableRows,
  buildBlockA,
  lastMonthColumnLabel,
} from "../salesDailyBlockA";
import { median, workingDaysElapsed } from "../workingTime";
import {
  BLOCK_B_COLUMNS,
  BLOCK_B_PCT_COLUMN,
  BLOCK_C_COLUMNS,
  BLOCK_C_PCT_COLUMN,
  BLOCK_D_COLUMNS,
  NO_OWNER_KEY,
  blockDRows,
  buildRepBlocks,
  loadAwaitingFieldVisit,
  loadRepExtras,
  repBlockTableRows,
} from "../salesDailyBlocks";
import { formatSlotTime } from "../schedule";
import { fmtDay, staleAlertText } from "@/lib/sales/invoiceFreshnessRules";
import { ECOFY_STAGE_LABELS } from "@/lib/ecofy/access";
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
//   B Field team (ASM)          one row per ASM, Block A's field metrics as
//                               columns, Yesterday + MTD (29 Sep: no Last 7 days
//                               here), one % of target column (salesDailyBlocks.ts).
//   C Inside sales (ISR / CC)   one row per ISR, Block A's calling metrics plus
//                               Connected / Connect % / Engaged MTD, same shape.
//   D Position this morning     open Hot / Warm / Cold per owner, awaiting
//                               field visit, and sales-ready leads with no owner.
//   E Today and tomorrow        scheduled visits and follow-ups per owner.
//   F Oldest overdue            the 10 oldest overdue items, by name and city — no phone numbers:
//                               follow-ups, visits and (IDs 85 / 86) limits passed and still
//                               unanswered, each charged to the owner when it fell due.
//   G Ecofy                     pickup queue, new Ecofy leads yesterday, leads by stage (ID 51).
const SECTIONS: DigestSection[] = [
  { key: "summary", label: "Headline", hint: "One line: yesterday's outcome and what is behind target.", group: "activity" },
  { key: "block_a", label: "A · Company", hint: "22 metrics: yesterday, last 7 days, MTD, MTD target, % of target, same period last month, Δ.", group: "activity" },
  { key: "right_now", label: "Right now", hint: "Ready leads with no owner (Hot / AI qualified / other), and the oldest wait.", group: "backlog" },
  { key: "block_b", label: "B · Field team (ASM)", hint: "One row per ASM: dealers visited, new dealers visited, hot received, quotes created (yesterday and MTD); quotes delivered, dealer approved, Won, converted, revenue (MTD); % of dealer-visit target.", group: "activity" },
  { key: "block_c", label: "C · Inside sales (ISR / CC)", hint: "One row per ISR: calls, dealers called (yesterday and MTD); connected, connect %, engaged, hot to field, quotes created, Won, converted (MTD); % of calls target.", group: "activity" },
  { key: "block_d", label: "D · Position this morning", hint: "Open Hot / Warm / Cold per owner, Hot rated 8+ days ago, awaiting field visit, and sales-ready leads with no owner — as of the send time.", group: "backlog" },
  { key: "block_e", label: "E · Today and tomorrow", hint: "Scheduled visits and follow-ups due, per owner.", group: "backlog" },
  { key: "block_f", label: "F · Oldest overdue", hint: "The 10 oldest overdue follow-ups, visits and time limits passed (still unanswered), by name.", group: "backlog" },
  // ID 51 — Ecofy leads in the daily email.
  { key: "block_g", label: "G · Ecofy", hint: "Ecofy pickup queue (unassigned), new Ecofy leads yesterday, and every Ecofy lead by stage.", group: "backlog" },
];

// ─────────────────────────────── dates ──────────────────────────────────────

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function firstOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** 1st of last month → the same day of last month (capped at its last day). */
export function sameSpanLastMonth(iso: string): { from: string; to: string } {
  const d = new Date(`${iso}T00:00:00Z`);
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).getUTCDate();
  const to = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d.getUTCDate(), lastDay)));
  return { from: first.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/**
 * The four windows every Block A row is counted over, for the covered IST day.
 * Inclusive IST days. On the 1st–7th of a month MTD sits inside Last 7 days,
 * so a count can never show MTD above Last 7 there.
 */
export function salesDailyPeriods(istDay: string) {
  return {
    yesterday: { from: istDay, to: istDay },
    last7: { from: addDays(istDay, -6), to: istDay },
    mtd: { from: firstOfMonth(istDay), to: istDay },
    lastMonth: sameSpanLastMonth(istDay),
  };
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

type RightNow = {
  waiting: number;
  /** ID 184 — Hot / AI qualified / other, as on the Sales dashboard card. */
  split: { hot: number; ai: number; other: number } | null;
  oldestDays: number | null;
  /** The sales_ready_unassigned limit in force (calendar days). */
  limitDays: number;
  /** Hot, sales-ready leads with no owner (running hot_assign clocks, E-350); null = not measured. */
  hotWaiting: number | null;
  /** …of those, past the hot_ready_to_assigned limit. */
  hotPast: number | null;
  /** The hot_ready_to_assigned limit in force (working hours). */
  hotLimitHours: number;
};

async function rightNow(): Promise<RightNow> {
  const { getTimeLimits } = await import("@/lib/timeLimits/store");
  const limits = await getTimeLimits();
  const base: RightNow = {
    waiting: 0,
    split: null,
    oldestDays: null,
    limitDays: limits.sales_ready_unassigned,
    hotWaiting: null,
    hotPast: null,
    hotLimitHours: limits.hot_ready_to_assigned,
  };
  try {
    // ID 82: the one "awaiting assignment" rule — the Ready to assign page
    // and the CEO card count the same leads. Imported here, not at module
    // scope: listing the digest kinds must not need DATABASE_URL.
    const { countAwaitingAssignment } = await import("@/lib/leads/salesReady");
    const c = await countAwaitingAssignment();
    Object.assign(base, { waiting: c.total, oldestDays: c.oldestDays, split: c.split });
  } catch {
    /* not measured */
  }
  try {
    // ID 85 (15 Oct): Hot leads have their own limit to get an owner.
    const { hasLimitEvents } = await import("@/lib/leads/clocks");
    if (await hasLimitEvents()) {
      const { db } = await import("@/lib/db");
      const [r] = (await db.execute(sql`
        SELECT COUNT(*)::int AS waiting, COUNT(*) FILTER (WHERE c.limit_passed_at IS NOT NULL)::int AS past
          FROM lead_clocks c
         WHERE c.clock = 'hot_assign' AND c.first_attempt_at IS NULL AND c.ended_at IS NULL
      `)) as unknown as Array<{ waiting: number; past: number }>;
      Object.assign(base, { hotWaiting: Number(r?.waiting ?? 0), hotPast: Number(r?.past ?? 0) });
    }
  } catch (e) {
    console.warn("[sales-daily] hot waiting not measured:", e instanceof Error ? e.message : e);
  }
  return base;
}

/**
 * "Median wait, sales-ready → assigned (MTD)" (business template, Right now).
 * Leads whose FIRST owner arrived this month after they had become
 * sales-ready; the wait is in working days (workingTime.ts). A lead that was
 * sales-ready BECAUSE it got an owner (picked up in NeoDove, rep-created,
 * claimed — on db-2 every October assignment so far) never waited and is not
 * in the median. null = nothing measurable.
 */
async function medianWaitToAssign(mtd: { from: string; to: string }): Promise<{ median: number | null; n: number } | null> {
  try {
    const { db } = await import("@/lib/db");
    const rows = (await db.execute(sql`
      WITH first_hop AS (
        SELECT DISTINCT ON (t.dealer_lead_id) t.dealer_lead_id, t.performed_at
          FROM lead_touchpoints t
         WHERE t.to_owner_id IS NOT NULL
         ORDER BY t.dealer_lead_id, t.performed_at
      )
      SELECT (to_jsonb(dl) ->> 'sales_ready_at') AS ready_at, f.performed_at::text AS assigned_at
        FROM dealer_leads dl
        JOIN first_hop f ON f.dealer_lead_id = dl.id
       WHERE (to_jsonb(dl) ->> 'sales_ready_at') IS NOT NULL
         AND (f.performed_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${mtd.from}::date AND ${mtd.to}::date
         AND f.performed_at > (to_jsonb(dl) ->> 'sales_ready_at')::timestamptz
    `)) as unknown as Array<{ ready_at: string; assigned_at: string }>;
    const hol = (await db.execute(sql`
      SELECT holiday_date::text AS d FROM holiday_calendar
       WHERE is_active IS NOT FALSE AND holiday_date >= (${mtd.from}::date - 60)
    `).catch(() => [])) as unknown as Array<{ d: string }>;
    const set = new Set(hol.map((h) => h.d));
    const waits = rows.map((r) => workingDaysElapsed(new Date(r.ready_at), new Date(r.assigned_at), set));
    return { median: median(waits), n: waits.length };
  } catch (e) {
    console.warn("[sales-daily] median wait not measured:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** "5 Oct 2026, 9:02 AM" — an instant in IST, as the masthead shows it. */
export function istStamp(d: Date): string {
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).replace(/\b(am|pm)\b/, (s) => s.toUpperCase());
}

/** "Sunday 4 October" / "Sun 4 Oct 2026" for the covered day. */
function dayNames(istDay: string): { long: string; short: string } {
  const d = new Date(`${istDay}T12:00:00Z`);
  const f = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-GB", { timeZone: "UTC", ...o }).replace(/,/g, "");
  return {
    long: f({ weekday: "long", day: "numeric", month: "long" }),
    short: f({ weekday: "short", day: "numeric", month: "short", year: "numeric" }),
  };
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

const CLOCK_WORDS: Record<string, string> = {
  lead: "first call or visit",
  owner: "owner's first call or visit",
  transfer: "first field visit",
  hot_assign: "Hot lead getting an owner",
  hot_owner: "Hot lead first call or visit",
  retry: "retry after an unanswered call",
  quote: "CEO quote approval",
};

/**
 * Block F: the 10 oldest overdue follow-ups, visits and (IDs 85 / 86) time
 * limits passed and still unanswered — by name and city, never a phone
 * number. A limit is listed under the owner it was charged to (the owner when
 * it fell due). Days are counted to today in IST.
 */
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
  const items = rows.map((r) => ({ ...r, due: String(r.due).slice(0, 10) }));
  try {
    const { limitPassedEvents } = await import("@/lib/leads/clocks");
    const { istDay: istDayOf } = await import("@/lib/calendar/officeCalendar");
    const passed = await limitPassedEvents({ openOnly: true, limit: 10 });
    const cities = passed.length
      ? ((await db.execute(sql`
          SELECT id, city, shop_name FROM dealer_leads WHERE id IN ${passed.map((p) => p.dealer_lead_id)}
        `)) as unknown as Array<{ id: string; city: string | null; shop_name: string | null }>)
      : [];
    const byId = new Map(cities.map((c) => [c.id, c]));
    for (const p of passed) {
      const lead = byId.get(p.dealer_lead_id);
      items.push({
        dealer: p.dealer_name ?? lead?.shop_name ?? p.dealer_lead_id,
        city: lead?.city ?? null,
        owner: p.owner_name,
        what: `Limit passed: ${CLOCK_WORDS[p.clock] ?? p.clock}`,
        due: istDayOf(new Date(p.passed_at)),
      });
    }
  } catch (e) {
    console.warn("[sales-daily] limits passed not listed:", e instanceof Error ? e.message : e);
  }
  // Today in IST — the UTC date reads yesterday until 05:30.
  const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  return items
    .sort((a, b) => a.due.localeCompare(b.due))
    .slice(0, 10)
    .map((r) => {
      const days = Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.due}T00:00:00Z`)) / 86400000));
      return [r.dealer, r.city?.trim() || "—", r.owner ?? "(no owner)", r.what, r.due, days];
    });
}

/**
 * ID 51 — Block G: Ecofy leads (E-305 / E-307) as of the send time. The
 * pickup queue (S1 with no owner, the workspace's own rule in
 * src/lib/ecofy/queries.ts), leads that came in on the covered day, and every
 * lead by stage. null = no ecofy_leads table on this database, or the read
 * failed — the block then says so instead of breaking the email.
 */
export type EcofySnapshot = { queue: number; newYesterday: number; byStage: Array<{ stage: string | null; n: number }> };

async function ecofySnapshot(istDay: string): Promise<EcofySnapshot | null> {
  try {
    const { db } = await import("@/lib/db");
    const probe = (await db.execute(sql`
      SELECT to_regclass('public.ecofy_leads') IS NOT NULL AS ok
    `)) as unknown as Array<{ ok: boolean }>;
    if (!probe[0]?.ok) return null;
    const [head] = (await db.execute(sql`
      SELECT COUNT(*) FILTER (WHERE e.stage = 'S1' AND e.assigned_to_user_id IS NULL)::int AS queue,
             COUNT(*) FILTER (WHERE (e.created_at AT TIME ZONE 'Asia/Kolkata')::date = ${istDay}::date)::int AS new_yesterday
        FROM ecofy_leads e
    `)) as unknown as Array<{ queue: number; new_yesterday: number }>;
    const stages = (await db.execute(sql`
      SELECT e.stage, COUNT(*)::int AS n FROM ecofy_leads e GROUP BY e.stage
    `)) as unknown as Array<{ stage: string | null; n: number }>;
    return {
      queue: Number(head?.queue ?? 0),
      newYesterday: Number(head?.new_yesterday ?? 0),
      byStage: stages.map((s) => ({ stage: s.stage, n: Number(s.n) })),
    };
  } catch (e) {
    console.warn("[sales-daily] Ecofy block not measured:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Block G rows: the two headline counts, then one row per stage in pipeline order (S0 … S8, Closed, unknown last). */
export function ecofyBlockRows(s: EcofySnapshot, stageLabels: Record<string, string>): DigestTable["rows"] {
  const order = Object.keys(stageLabels);
  const rank = (st: string | null) => (st && order.includes(st) ? order.indexOf(st) : order.length);
  const stages = [...s.byStage]
    .filter((x) => x.n > 0)
    .sort((a, b) => rank(a.stage) - rank(b.stage) || String(a.stage).localeCompare(String(b.stage)));
  const total = stages.reduce((acc, x) => acc + x.n, 0);
  return [
    ["Pickup queue (unassigned)", s.queue],
    ["New leads yesterday", s.newYesterday],
    ["BY STAGE", ""],
    ...stages.map((x): Array<string | number> => [
      x.stage ? `${x.stage} · ${stageLabels[x.stage] ?? x.stage}` : "(no stage)",
      x.n,
    ]),
    ["All Ecofy leads", total],
  ];
}

// ─────────────────────────────── collect ────────────────────────────────────

async function collect(
  istDay: string,
): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    const { buildSalesDashboard } = await import("@/lib/admin/salesDashboard");
    const { db } = await import("@/lib/db");
    // The cut-off: every query below starts after this instant, so nothing the
    // email shows was recorded later. Shown as "Data updated till …".
    const computedAt = new Date();
    const sendDay = addDays(istDay, 1);
    const dayAfter = addDays(istDay, 2);
    const periods = salesDailyPeriods(istDay);

    const { getDigestSettings } = await import("../settings");
    const [yesterday, last7, mtd, lastMonth, scheduled, followUps, now, overdue, settings, extrasY, extrasMtd, awaiting, unmatched, wait, ecofy] = await Promise.all([
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
      medianWaitToAssign(periods.mtd),
      ecofySnapshot(istDay),
    ]);
    const blockA = await buildBlockA(db as never, periods, { yesterday, last7, mtd, lastMonth }, unmatched);
    // ID 156: each rep's manager today, so Blocks B / C show a team subtotal
    // under each manager. Imported here, not at module scope (needs the db).
    const teamOf = await (await import("@/lib/users/team")).currentTeamOf();
    // ID 171: how far the invoice data behind Revenue / Batteries goes, and the
    // Admin alert line when no new invoice was read for the limit's working days.
    const invoices = await (await import("@/lib/sales/invoiceFreshness")).invoiceFreshness({ fresh: true }).catch(() => null);
    // ID 174: "Stock to upload" tasks (E-348) — null on a database without them.
    const stockTasks = await (await import("@/lib/inventory/stockUploadTasks/service")).stockTaskCounts().catch(() => null);
    // "Right now" / "Position at" name the moment the figures were taken — a
    // test sent at 14:03 used to say "Right now · 09:00".
    const asOf = computedAt.toLocaleTimeString("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const sendTime = formatSlotTime(settings.morningHour, settings.morningMinute);
    const days = dayNames(istDay);
    const mtdRange = lastMonthColumnLabel(periods.mtd);
    const lmLabel = lastMonthColumnLabel(periods.lastMonth);
    const blockAColumns = BLOCK_A_COLUMNS.map((c) => (c === "Same period last month" ? lmLabel : c));
    const col = (name: string) => BLOCK_A_COLUMNS.indexOf(name);
    const waitValue =
      wait == null
        ? "Not measured yet"
        : wait.median == null
          ? "—"
          : `${wait.median.toFixed(1)} working day${wait.median.toFixed(1) === "1.0" ? "" : "s"}`;
    const waitHint =
      wait && wait.median == null
        ? "No lead waited for an owner this month: each got one as it became sales-ready. Limit: Hot 24 hours, others 2 working days"
        : `Limit: Hot 24 hours, others 2 working days${wait ? ` · ${wait.n} lead${wait.n === 1 ? "" : "s"}` : ""}`;
    const extras = { y: extrasY, mtd: extrasMtd };

    // Names for Block E: the builder's per-rep blocks, then users for the rest.
    const names = new Map<string, string>();
    for (const d of [yesterday, mtd]) for (const b of d.per_spoc ?? []) names.set(b.spoc_id, b.name ?? b.spoc_id);
    const awaitingIds = [...(awaiting?.keys() ?? [])].filter((id) => id !== NO_OWNER_KEY);
    const missing = [...new Set([...scheduled.keys(), ...followUps.keys(), ...awaitingIds])].filter((id) => !names.has(id));
    if (missing.length) {
      const rows = (await db.execute(sql`
        SELECT id::text AS id, name, is_active FROM users
         WHERE id::text IN (${sql.join(missing.map((m) => sql`${m}`), sql`, `)})
      `)) as unknown as Array<{ id: string; name: string | null; is_active: boolean | null }>;
      // A deactivated owner still holding leads is flagged, as in blockDRows.
      for (const r of rows) names.set(r.id, (r.name ?? r.id) + (r.is_active === false ? " (inactive)" : ""));
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
        headline: blockAHeadlineParts(blockA.rows),
        wide: true,
        backlog: [],
        // Business template "Daily Sales email · Block A" (docs/crm-reports-admin).
        masthead: {
          title: `Daily Sales · ${days.short}`,
          audience: "iTarang CRM to Sales leadership",
          dataAsOf: istStamp(computedAt),
          eyebrow: "ITARANG · DAILY SALES",
          dayHeading: days.long,
          intro:
            `Covers ${days.long}, midnight to midnight IST. ` +
            (blockA.workingDays.total > 0
              ? `Month to date is ${mtdRange}: ${blockA.workingDays.elapsed} of ${blockA.workingDays.total} working days, ` +
                `so targets below are ${blockA.workingDays.elapsed}/${blockA.workingDays.total} of the monthly target.`
              : `Month to date is ${mtdRange}.`),
          firstBlockHint: "Lead lists for every number in the Sales Dashboard",
          footer: `Sent by the iTarang CRM every morning at ${sendTime} IST. Recipients are set by Admin.`,
        },
        tables: [
          {
            key: "block_a",
            title: "A · Company",
            columns: blockAColumns,
            rows: blockATableRows(blockA.rows),
            rowNotes: blockARowNotes(blockA.rows),
            textColumns: 1,
            groupHeaders: true,
            toneColumns: [BLOCK_A_PCT_COLUMN],
            deltaColumns: [col("Δ MTD")],
            strongColumn: col("MTD"),
            // Phone frame: METRIC · YDAY · MTD (Δ under it) · TARGET.
            phoneColumns: [0, col("Yesterday"), col("MTD"), BLOCK_A_PCT_COLUMN],
            phoneDeltaUnder: [col("Δ MTD"), col("MTD")],
            // The working-days sentence is already the intro; keep the rest.
            note: blockA.targetsNote.replace(/^Month to date is [^.]*\.\s*/, "") || undefined,
            // "Right now" sits right after the table, as in the mockup.
            footer: {
              key: "right_now",
              label: `Right now · ${asOf}`,
              items: [
                {
                  label: "Ready leads with no owner",
                  value: `${now.waiting} lead${now.waiting === 1 ? "" : "s"}`,
                  // Calendar days, as the Ready to assign page and the CEO card
                  // count it; red from the Admin limit (ID 85), not a fixed 2.
                  // ID 184: the card's Hot / AI / other split rides in front.
                  hint:
                    [
                      now.split ? `${now.split.hot} Hot · ${now.split.ai} AI qualified · ${now.split.other} other` : null,
                      now.oldestDays != null ? `oldest waiting ${now.oldestDays} days · limit ${now.limitDays} days` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || undefined,
                  alert: now.oldestDays != null && now.oldestDays >= now.limitDays,
                },
                ...(now.hotWaiting != null
                  ? [
                      {
                        label: "Hot, ready, no owner",
                        // The card's Hot count (ID 184); the past-limit figure is the hot_assign clock.
                        value: `${now.split?.hot ?? now.hotWaiting} lead${(now.split?.hot ?? now.hotWaiting) === 1 ? "" : "s"}`,
                        hint: `${now.hotPast ?? 0} past the ${now.hotLimitHours}-working-hour limit`,
                        alert: (now.hotPast ?? 0) > 0,
                      },
                    ]
                  : []),
                { label: "Median wait, sales-ready → assigned (MTD)", value: waitValue, hint: waitHint },
                ...(invoices
                  ? [
                      {
                        label: "Invoices read up to",
                        value: invoices.read_up_to ? fmtDay(invoices.read_up_to) : "No invoices read yet",
                        // Revenue and Batteries sold above count invoices up to this date.
                        hint:
                          staleAlertText(invoices) ??
                          `Revenue and Batteries sold count invoices up to this date · alert after ${invoices.stale_after} working days with no new invoice`,
                        alert: invoices.stale,
                      },
                    ]
                  : []),
                ...(stockTasks
                  ? [
                      {
                        label: "Stock to upload",
                        value: stockTasks.line,
                        hint: "New battery invoices whose serials are not all in the buyer dealer's stock · overdue = open after 2 working days",
                        alert: stockTasks.overdue > 0,
                      },
                    ]
                  : []),
              ],
            },
            legend: [
              "% of target: green 100% or more · amber 80–99% · red below 80%.",
              "—: no target is set for this metric, or no figure to compare.",
              "n/t: not tracked in that period.",
              "Not measured yet: the CRM does not record this yet.",
            ],
          },
          {
            key: "block_b",
            title: "B · Field team (ASM)",
            columns: BLOCK_B_COLUMNS,
            rows: repBlockTableRows("asm", buildRepBlocks("asm", yesterday, mtd, extras, blockA.userTargets), teamOf),
            textColumns: 1,
            toneColumns: [BLOCK_B_PCT_COLUMN],
            note:
              "One row per ASM. % of target = dealers visited MTD against the ASM's MTD dealer-visit target (“—” = no target set). " +
              "Under a manager: their team (↳) and a team subtotal — % of target against the manager's own target. " +
              "Total = the ASMs listed; Block A also counts work credited to nobody. " +
              // A26: the same figures as Admin › Targets, which runs to today.
              `MTD = ${periods.mtd.from} to ${periods.mtd.to}, the same per-person figures as Admin › Targets (which also counts today).`,
            empty: "No ASMs on the Sales dashboard this month.",
          },
          {
            key: "block_c",
            title: "C · Inside sales (ISR / CC)",
            columns: BLOCK_C_COLUMNS,
            rows: repBlockTableRows("inside_sales_rep", buildRepBlocks("inside_sales_rep", yesterday, mtd, extras, blockA.userTargets), teamOf),
            textColumns: 1,
            toneColumns: [BLOCK_C_PCT_COLUMN],
            note:
              "One row per ISR / CC, and anyone else who made calls (named with their role). Connected = calls that connected, each counted once. " +
              "Engaged = connected, of any length (since 3 Oct). Hot to field = leads handed to an ASM that were Hot at that moment. " +
              "% of target = calls MTD against the rep's MTD calls target (“—” = no target set). " +
              "Under a manager: their team (↳) and a team subtotal against the manager's own target.",
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
          {
            // ID 51 — Ecofy leads, as of the send time.
            key: "block_g",
            title: `G · Ecofy at ${asOf}`,
            columns: ["Ecofy leads", "Leads"],
            rows: ecofy ? ecofyBlockRows(ecofy, ECOFY_STAGE_LABELS) : [],
            textColumns: 1,
            groupHeaders: true,
            note: ecofy
              ? "Pickup queue: at S1 with no owner, as on the Ecofy Pickup Queue page. New leads yesterday: first received from Ecofy on the covered day."
              : undefined,
            empty: ecofy ? "No Ecofy leads yet." : "Ecofy leads could not be read on this database.",
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
    "as of the send time, E · Today and tomorrow, F · the 10 oldest overdue items, and G · Ecofy " +
    "(pickup queue, new leads yesterday, leads by stage). No personal " +
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
