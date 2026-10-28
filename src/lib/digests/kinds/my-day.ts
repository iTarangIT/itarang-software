/**
 * "My day" digest (tracker ID 194, decided 14–15 Oct 2026) — one email per
 * active ISR and ASM, every working morning (Mon–Sat) at the time set on
 * /admin/settings/my-day (default 09:00 IST). Admin switches it on per role.
 *
 *   My numbers   the person's own row of the management email's Block B (ASM)
 *                or C (ISR) — yesterday and MTD — and their targets to date
 *                against the actual (the Targets page's measures).
 *   My work list follow-ups due today / tomorrow / overdue, visits due or
 *                overdue, time limits passed and still unanswered, every lead
 *                waiting for a field visit, quotes with no dealer answer, and
 *                idle leads — each a link to the lead.
 *
 * A manager's team is NOT in this mail (ID 198, Kartik 27 Oct): it is a second,
 * separate email, "My team" (./my-team.ts), sent at the same time under the
 * same switch.
 *
 * No company totals, no other teams, no ranking.
 *
 * SAME NUMBERS AS THE MANAGEMENT EMAIL. The rows come from the very functions
 * the Sales Daily mail uses (buildSalesDashboard per period → buildRepBlocks →
 * repBlockTableRows, myDayShape.ts), over the same covered day, so a person's
 * row here equals their row there. scripts/verify-sales-daily.ts --my-day
 * checks it. "Yesterday" is the last working day on the office calendar, as
 * in the management email (salesDailyPeriodsFor) — on a Monday, Saturday.
 *
 * The expensive part (two dashboard builds, the per-rep extras, the targets)
 * is the same for everyone, so it is built once per covered day and reused by
 * every person in the run (`sharedFor`, 15-minute cache).
 *
 * `db` is imported inside the queries, never at module scope — the registry
 * lists every kind, and listing must not require DATABASE_URL.
 */

import { sql } from "drizzle-orm";

import {
  BLOCK_B_COLUMNS,
  BLOCK_B_PCT_COLUMN,
  BLOCK_C_COLUMNS,
  BLOCK_C_PCT_COLUMN,
  buildRepBlocks,
  type RepBlock,
} from "../salesDailyBlocks";
import {
  personRows,
  sameDayLastWeekRows,
  targetRows,
  workListRows,
  type TargetLine,
  type WorkItem,
} from "../myDayShape";
import type {
  DigestDetail,
  DigestFigures,
  DigestKindDescriptor,
  DigestPerson,
  DigestSection,
  DigestTable,
} from "../types";
import { addDays, salesDailyPeriodsFor } from "./sales-daily";
import { limitPassedWords } from "@/lib/leads/limitEventLabels";

export const ROLES = ["inside_sales_rep", "asm"] as const;
export type Role = (typeof ROLES)[number];

const SECTIONS: DigestSection[] = [
  { key: "my_numbers", label: "My numbers", hint: "The person's own row of the management email (yesterday and MTD), yesterday against the same day last week, and each target to date against the actual.", group: "activity" },
  { key: "work_list", label: "My work list", hint: "Follow-ups due today, tomorrow or overdue; visits due or overdue; time limits passed and still unanswered; every lead waiting for a field visit; quotes with no answer from the dealer; and idle leads — each opens the lead.", group: "backlog" },
  // ID 198: switches the separate "My team" email (./my-team.ts), which reads these settings.
  { key: "my_team", label: "My team email (managers only)", hint: "A second email to anyone with people reporting to them: each member's numbers and the team subtotal (as in the management email), then each member's leads to review.", group: "backlog" },
];

// ─────────────────────────────── people ─────────────────────────────────────

/** Active ISRs and ASMs with an email, for the roles switched on. */
export async function people(settings: { roles: Record<string, boolean> }): Promise<DigestPerson[]> {
  const roles = ROLES.filter((r) => settings.roles[r]);
  if (roles.length === 0) return [];
  const { db } = await import("@/lib/db");
  const rows = (await db.execute(sql`
    SELECT id::text AS id, COALESCE(name, email) AS name, email, lower(role) AS role
      FROM users
     WHERE is_active = TRUE AND email IS NOT NULL AND trim(email) <> ''
       AND lower(role) IN (${sql.join(roles.map((r) => sql`${r}`), sql`, `)})
     ORDER BY name
  `)) as unknown as DigestPerson[];
  return rows.map((r) => ({ ...r, email: r.email.trim() }));
}

// ─────────────────────────────── shared per day ─────────────────────────────

export type Shared = {
  blocks: Record<Role, RepBlock[]>;
  /** ID 194 #1: the same blocks over the same day last week (its figures in `.y`). */
  wkBlocks: Record<Role, RepBlock[]>;
  teamOf: Map<string, string>;
  /** user id → metric → pro-rated MTD target (calls_per_day: × working days). */
  targets: Map<string, Map<string, number>>;
  elapsed: number;
  total: number;
  measure: (userId: string, metric: string) => { value: number | null };
};

const cache = new Map<string, { at: number; value: Promise<Shared> }>();
const CACHE_MS = 15 * 60_000;

async function buildShared(istDay: string): Promise<Shared> {
  const { buildSalesDashboard } = await import("@/lib/admin/salesDashboard");
  const { db } = await import("@/lib/db");
  const { loadRepExtras } = await import("../salesDailyBlocks");
  const { companyTargets } = await import("../salesDailyBlockA");
  const { currentTeamOf } = await import("@/lib/users/team");
  const { measuresFor } = await import("@/lib/targets/service");
  const periods = await salesDailyPeriodsFor(istDay);
  // The same calls, with the same arguments, as the management email's collect.
  const [yesterday, mtd, wk, extrasY, extrasMtd, extrasWk, t, teamOf] = await Promise.all([
    buildSalesDashboard({ ...periods.yesterday, granularity: "day" }),
    buildSalesDashboard({ ...periods.mtd, granularity: "day" }),
    buildSalesDashboard({ ...periods.sameDayLastWeek, granularity: "day" }),
    loadRepExtras(db as never, periods.yesterday),
    loadRepExtras(db as never, periods.mtd),
    loadRepExtras(db as never, periods.sameDayLastWeek),
    companyTargets(db as never, periods.mtd.from, periods.mtd.to),
    currentTeamOf(),
  ]);
  const extras = { y: extrasY, mtd: extrasMtd };
  // Same day last week in the "y" slot; its MTD half is never read.
  const extrasWkPair = { y: extrasWk, mtd: extrasWk };
  const measure = await measuresFor(periods.mtd.from, periods.mtd.to, t.elapsed);
  return {
    blocks: {
      asm: buildRepBlocks("asm", yesterday, mtd, extras, t.perUser),
      inside_sales_rep: buildRepBlocks("inside_sales_rep", yesterday, mtd, extras, t.perUser),
    },
    wkBlocks: {
      asm: buildRepBlocks("asm", wk, wk, extrasWkPair, t.perUser),
      inside_sales_rep: buildRepBlocks("inside_sales_rep", wk, wk, extrasWkPair, t.perUser),
    },
    teamOf,
    targets: t.perUser,
    elapsed: t.elapsed,
    total: t.total,
    measure,
  };
}

export function sharedFor(istDay: string): Promise<Shared> {
  const hit = cache.get(istDay);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = buildShared(istDay);
  // A failed build must not be served to the next person.
  value.catch(() => cache.delete(istDay));
  cache.set(istDay, { at: Date.now(), value });
  return value;
}

// ─────────────────────────────── per person ─────────────────────────────────

async function targetLines(person: DigestPerson, s: Shared, monthFirst: string): Promise<TargetLine[]> {
  const mine = s.targets.get(person.id);
  if (!mine || mine.size === 0) return [];
  const { TARGET_METRICS, isTargetMetric } = await import("@/lib/targets/rules");
  // A custom metric (ID 189) is named on its own target row.
  const custom = [...mine.keys()].filter((m) => !isTargetMetric(m));
  const names = new Map<string, string>();
  if (custom.length) {
    const { db } = await import("@/lib/db");
    const rows = (await db.execute(sql`
      SELECT DISTINCT ON (metric) metric, custom_label FROM sales_targets
       WHERE user_id::text = ${person.id} AND month = ${monthFirst}::date
         AND metric IN (${sql.join(custom.map((m) => sql`${m}`), sql`, `)}) AND custom_label IS NOT NULL
    `)) as unknown as Array<{ metric: string; custom_label: string }>;
    for (const r of rows) names.set(r.metric, r.custom_label);
  }
  const lines: TargetLine[] = [];
  for (const [metric, mtdTarget] of mine) {
    const known = isTargetMetric(metric) ? TARGET_METRICS[metric] : null;
    const kind = known?.kind ?? "count";
    // calls_per_day was multiplied by working days elapsed for the email's
    // % of target; shown here as the daily rate, against the daily average.
    const target = kind === "per_day" ? (s.elapsed > 0 ? mtdTarget / s.elapsed : 0) : mtdTarget;
    lines.push({ label: known?.label ?? names.get(metric) ?? metric, kind, target, actual: s.measure(person.id, metric).value });
  }
  return lines.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The work list (ID 194, 18 Oct sheet): follow-ups due today, tomorrow or
 * overdue; visits due or overdue; time limits passed and still unanswered;
 * every lead waiting for a field visit (the card's rule, awaitingFieldVisitSql
 * — not only those past the limit); quotes delivered with no answer from the
 * dealer (the "Quotes with no answer" card's rule); and leads idle past the
 * holder's limit (the Needs Attention rule).
 */
export async function workItems(person: Pick<DigestPerson, "id">, sendDay: string): Promise<WorkItem[]> {
  const { db } = await import("@/lib/db");
  const tomorrow = addDays(sendDay, 1);
  const dated = (await db.execute(sql`
    SELECT dl.id AS lead_id, COALESCE(dl.dealer_name, dl.shop_name, dl.id) AS dealer, dl.city,
           'Follow-up' AS what, ((dl.next_follow_up_at AT TIME ZONE 'Asia/Kolkata')::date)::text AS due
      FROM dealer_leads dl
     WHERE dl.current_owner_id = ${person.id} AND dl.is_active IS NOT FALSE
       AND COALESCE(dl.lead_status, '') NOT IN ('Won', 'Converted', 'Lost')
       AND (dl.next_follow_up_at AT TIME ZONE 'Asia/Kolkata')::date <= ${tomorrow}::date
    UNION ALL
    SELECT dl.id, COALESCE(dl.dealer_name, dl.shop_name, dl.id), dl.city, 'Visit', v.scheduled_date::text
      FROM lead_visits v
      JOIN dealer_leads dl ON dl.id = v.dealer_lead_id
     WHERE v.asm_id::text = ${person.id}
       AND v.scheduled_date <= ${sendDay}::date
       AND v.visit_status IN ('scheduled', 'pending_scheduling')
       AND COALESCE(dl.lead_status, '') NOT IN ('Won', 'Converted', 'Lost')
  `)) as unknown as Array<{ lead_id: string; dealer: string; city: string | null; what: string; due: string }>;
  const daysLate = (due: string) =>
    Math.max(0, Math.round((Date.parse(`${sendDay}T00:00:00Z`) - Date.parse(`${due.slice(0, 10)}T00:00:00Z`)) / 86400000));
  const items: WorkItem[] = dated.map((r) => {
    const due = String(r.due).slice(0, 10);
    const late = daysLate(due);
    const visit = r.what === "Visit";
    return {
      lead_id: r.lead_id,
      dealer: r.dealer,
      city: r.city,
      what: late > 0 ? `${r.what} overdue` : due > sendDay ? `${r.what} tomorrow` : `${r.what} today`,
      due,
      days: late,
      // ID 198: visits due or overdue; follow-ups only once overdue.
      list: visit ? "visit" : late > 0 ? "follow_up" : undefined,
    };
  });

  // Every lead waiting for a field visit, quotes with no dealer answer and Hot
  // leads not called in time — the Sales dashboard cards' own rows, narrowed
  // to this person.
  try {
    const { listSalesHeadAction } = await import("@/lib/dashboard/salesHeadActions");
    const [waiting, quotes, hot] = await Promise.all([
      listSalesHeadAction("visit_overdue", { ownerId: person.id }),
      listSalesHeadAction("quotes_no_answer", { ownerId: person.id }),
      listSalesHeadAction("hot_not_called", { ownerId: person.id }),
    ]);
    for (const r of hot) {
      items.push({ lead_id: r.lead_id, dealer: r.dealer, city: r.city, what: "Hot lead not called in time", due: null, days: 0 });
    }
    for (const r of waiting) {
      items.push({
        lead_id: r.lead_id,
        dealer: r.dealer,
        city: r.city,
        what: r.past_limit ? "Waiting for a field visit · past the limit" : "Waiting for a field visit",
        due: null,
        days: Number(r.days ?? 0),
        list: "field_visit",
      });
    }
    for (const r of quotes) {
      items.push({
        lead_id: r.lead_id,
        dealer: r.dealer,
        city: r.city,
        what: "Quote with no answer from the dealer",
        due: null,
        days: Number(r.days ?? 0),
      });
    }
  } catch (e) {
    console.warn("[digest:my_day] field visits / quotes not listed:", e instanceof Error ? e.message : e);
  }

  // Time limits passed and still unanswered, charged to this person (E-350).
  try {
    const { limitPassedEvents } = await import("@/lib/leads/clocks");
    const { istDay } = await import("@/lib/calendar/officeCalendar");
    // Guessed owners are left out by limitPassedEvents itself.
    const passed = await limitPassedEvents({ openOnly: true, ownerId: person.id, limit: 500 });
    if (passed.length) {
      const cities = (await db.execute(sql`
        SELECT id, city, shop_name FROM dealer_leads
         WHERE id IN (${sql.join(passed.map((p) => sql`${p.dealer_lead_id}`), sql`, `)})
      `)) as unknown as Array<{ id: string; city: string | null; shop_name: string | null }>;
      const byId = new Map(cities.map((c) => [c.id, c]));
      for (const p of passed) {
        const due = istDay(new Date(p.passed_at));
        items.push({
          lead_id: p.dealer_lead_id,
          dealer: p.dealer_name ?? byId.get(p.dealer_lead_id)?.shop_name ?? p.dealer_lead_id,
          city: byId.get(p.dealer_lead_id)?.city ?? null,
          what: `Limit passed: ${limitPassedWords(p.clock)}`,
          due,
          days: daysLate(due),
          list: "limit",
        });
      }
    }
  } catch (e) {
    console.warn("[digest:my_day] limits passed not listed:", e instanceof Error ? e.message : e);
  }

  // Idle leads: the Needs Attention rule (per-role limit, follow-ups honoured).
  try {
    const { listNeedsAttention } = await import("@/lib/leads/needsAttention");
    for (const r of await listNeedsAttention({ holderId: person.id, limit: 50 })) {
      // A row listed only for its overdue visit is already on the list above.
      if (r.non_responsive || !r.past_idle) continue;
      items.push({
        lead_id: r.lead_id,
        dealer: r.dealer,
        city: r.city,
        what: `Idle ${r.days_idle} working days`,
        due: null,
        days: r.days_idle,
        list: "idle",
      });
    }
  } catch (e) {
    console.warn("[digest:my_day] idle leads not listed:", e instanceof Error ? e.message : e);
  }
  return items;
}

/** "Sat 24 Oct". */
export function dayShort(istDay: string): string {
  return new Date(`${istDay}T12:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
}

export function dayLong(istDay: string): string {
  return new Date(`${istDay}T12:00:00Z`)
    .toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" })
    .replace(/,/g, "");
}

export function istStamp(d: Date): string {
  return d.toLocaleString("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** One person's mail. Exported for scripts/verify-sales-daily.ts --my-day. */
export async function collectMyDay(
  istDay: string,
  person: DigestPerson,
): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    const computedAt = new Date();
    const role: Role = person.role === "asm" ? "asm" : "inside_sales_rep";
    const sendDay = addDays(istDay, 1);
    const s = await sharedFor(istDay);
    const { leadHrefFor, queueHrefFor } = await import("@/lib/leads/newOwnerNotice");
    const { appUrl } = await import("@/lib/email/sendDigestEmail");
    const periods = await salesDailyPeriodsFor(istDay);

    const [lines, work] = await Promise.all([targetLines(person, s, periods.mtd.from), workItems(person, sendDay)]);
    const mine = personRows(role, s.blocks[role], person.id);
    const list = workListRows(work);
    const base = appUrl();

    const tables: DigestTable[] = [
      {
        key: "my_numbers",
        title: role === "asm" ? "My numbers · field" : "My numbers · calling",
        columns: role === "asm" ? BLOCK_B_COLUMNS : BLOCK_C_COLUMNS,
        rows: mine,
        textColumns: 1,
        toneColumns: [role === "asm" ? BLOCK_B_PCT_COLUMN : BLOCK_C_PCT_COLUMN],
        note:
          `Yesterday = ${periods.yesterday.from}; MTD = ${periods.mtd.from} to ${periods.mtd.to}. ` +
          "The same row as yours in the management Sales email.",
        empty: "Nothing recorded for you yesterday or this month.",
      },
      {
        // ID 194 #1 (Kartik, 18 Oct): Yesterday against the same weekday last week.
        key: "my_numbers",
        title: "Yesterday against the same day last week",
        columns: ["Metric", `Yesterday · ${dayShort(periods.yesterday.from)}`, `Same day last week · ${dayShort(periods.sameDayLastWeek.from)}`],
        rows: sameDayLastWeekRows(role, s.blocks[role], s.wkBlocks[role], person.id),
        textColumns: 1,
        empty: "Nothing recorded for you on either day.",
      },
      {
        key: "my_numbers",
        title: "Targets to date",
        columns: ["Target", "Target to date", "Actual MTD", "% of target"],
        rows: targetRows(lines),
        textColumns: 1,
        toneColumns: [3],
        note:
          s.total > 0
            ? `${s.elapsed} of ${s.total} working days gone, so each monthly target is ${s.elapsed}/${s.total} of itself. ` +
              "Per-day targets are compared with your daily average."
            : undefined,
        empty: "No targets have been pushed to you for this month.",
      },
      {
        key: "work_list",
        title: `My work list · ${dayLong(sendDay)}`,
        columns: ["Dealer", "City", "What", "Due", "Days (late / waiting / idle)"],
        rows: list.rows,
        rowLinks: list.leadIds.map((id) => `${base}${leadHrefFor(role, id)}`),
        textColumns: 4,
        note: list.more > 0 ? `The ${list.rows.length} most urgent shown; ${list.more} more in your queue.` : undefined,
        empty: "Nothing due or overdue. Nothing idle.",
      },
    ];

    const first = person.name.split(/\s+/)[0] || person.name;
    return {
      ok: true,
      figures: {
        activity: [],
        backlog: [],
        wide: true,
        // ID 194: "Open my queue" opens the reader's own queue — /asm for an
        // ASM (who may not open the inside-sales queue), /inside-sales otherwise.
        ctaHref: queueHrefFor(role),
        // 194 #2: the subject names the day the numbers cover (Monday: Saturday).
        coveredDay: periods.yesterday.from,
        headline: [
          `Work list: ${list.rows.length + list.more} item${list.rows.length + list.more === 1 ? "" : "s"} for today.`,
        ],
        masthead: {
          title: `My day · ${person.name}`,
          audience: `iTarang CRM to ${person.name}`,
          dataAsOf: istStamp(computedAt),
          eyebrow: "ITARANG · MY DAY",
          dayHeading: dayLong(sendDay),
          intro: `Good morning ${first}. Your numbers cover ${dayLong(periods.yesterday.from)} and the month so far; the work list is for today.`,
          firstBlockHint: "Open a dealer to work the lead",
          footer: "Sent by the iTarang CRM every working morning. Admin switches it on per role.",
        },
        tables,
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[digest:my_day] build failed for ${person.id}:`, error);
    return { ok: false, figures: { activity: [], backlog: [] }, error };
  }
}

/**
 * The settings screen's preview / a plain `collect`: the first person's mail.
 * A real send never calls it — the engine fans out per person.
 */
async function collect(istDay: string): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    const [first] = await people({ roles: { inside_sales_rep: true, asm: true } });
    if (!first) return { ok: true, figures: { activity: [], backlog: [] } };
    return collectMyDay(istDay, first);
  } catch (err) {
    return { ok: false, figures: { activity: [], backlog: [] }, error: err instanceof Error ? err.message : String(err) };
  }
}

async function collectDetail(): Promise<{ ok: boolean; detail: DigestDetail; error?: string }> {
  return { ok: true, detail: {} };
}

export const myDayDigest: DigestKindDescriptor = {
  id: "my_day",
  label: "My day",
  description:
    "One email to each active ISR and ASM every working morning (Mon–Sat) at the time set below " +
    "(default 09:00 IST): their own numbers (yesterday, month to date, targets to date), their work " +
    "list with a link to each lead. Anyone with people reporting to them also gets a second email, " +
    "My team: each member's numbers, the team subtotal and each member's leads to review. No company " +
    "totals and no ranking. Switch it on per role; nothing is sent until a role is on.",
  settingsKey: "my_day_digest",
  settingsHref: "/admin/settings/my-day",
  ctaHref: "/inside-sales",
  ctaLabel: "Open my queue",
  sections: SECTIONS,
  slots: ["morning"],
  weekdays: [1, 2, 3, 4, 5, 6],
  defaults: { enabled: false, recipients: [], roles: { inside_sales_rep: false, asm: false } },
  roleSwitches: [
    { key: "inside_sales_rep", label: "ISRs (inside sales)" },
    { key: "asm", label: "ASMs (field)" },
  ],
  perRecipient: { resolve: people, collect: collectMyDay },
  subject: ({ dayLabel }) => `iTarang · My day — ${dayLabel}`,
  collect,
  collectDetail,
};
