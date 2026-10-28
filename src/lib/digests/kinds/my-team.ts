/**
 * "My team" digest (tracker ID 198, decided by Kartik 27 Oct 2026) — a second,
 * separate email to every ISR or ASM with people reporting to them (Sonu), at
 * the same time and under the same switch as their own "My day" (./my-day.ts),
 * which keeps only their own numbers and work list.
 *
 *   Team numbers      each member's row and the team subtotal, yesterday and
 *                     month to date against targets — the same rows as under
 *                     the manager in the management Sales email (teamRows).
 *   Leads to review   for each member: overdue follow-ups, visits due or
 *                     overdue, time limits passed, leads waiting for a field
 *                     visit and idle leads, each opening the lead; up to 10 per
 *                     list, then "and N more".
 *
 * Team = the people reporting to them in Reporting lines today (currentTeamOf);
 * ISRs and ASMs both. No company totals, no other teams, no ranking.
 *
 * Settings: none of its own (`settingsOf: "my_day"`) — My day's switch, time,
 * days and roles, and its "My team email" tick-box.
 */

import { sql } from "drizzle-orm";

import {
  BLOCK_B_COLUMNS,
  BLOCK_B_PCT_COLUMN,
  BLOCK_C_COLUMNS,
  BLOCK_C_PCT_COLUMN,
} from "../salesDailyBlocks";
import { membersOf, reviewRows, teamRows, type ReviewListKey } from "../myDayShape";
import type { DigestDetail, DigestFigures, DigestKindDescriptor, DigestPerson, DigestSection, DigestTable } from "../types";
import { addDays, salesDailyPeriodsFor } from "./sales-daily";
import { dayLong, istStamp, myDayDigest, people as myDayPeople, ROLES, sharedFor, workItems, type Role } from "./my-day";

const SECTIONS: DigestSection[] = myDayDigest.sections.filter((s) => s.key === "my_team");

/** My day's people who have someone reporting to them today. */
async function people(settings: { roles: Record<string, boolean> }): Promise<DigestPerson[]> {
  const everyone = await myDayPeople(settings);
  if (everyone.length === 0) return [];
  const { currentTeamOf } = await import("@/lib/users/team");
  const teamOf = await currentTeamOf();
  return everyone.filter((p) => membersOf(teamOf, p.id).length > 0);
}

/** Where "and N more" opens, for the manager reading the mail. */
function moreHref(list: ReviewListKey, memberId: string, managerRole: Role): string {
  // The one needs-action list a manager may open for their team (needsActionAccess).
  if (list === "field_visit") return `/admin/reports/needs-action/visit_overdue?spoc_id=${encodeURIComponent(memberId)}`;
  // Their queue lists the team's leads read-only (ID 155) until the team view (ID 199).
  return managerRole === "asm" ? "/asm" : "/inside-sales";
}

/** One manager's mail. Exported for scripts/verify-sales-daily.ts --my-team. */
export async function collectMyTeam(
  istDay: string,
  person: DigestPerson,
): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    const computedAt = new Date();
    const role: Role = person.role === "asm" ? "asm" : "inside_sales_rep";
    const sendDay = addDays(istDay, 1);
    const s = await sharedFor(istDay);
    const memberIds = membersOf(s.teamOf, person.id);
    const { leadHrefFor, queueHrefFor } = await import("@/lib/leads/newOwnerNotice");
    const { appUrl } = await import("@/lib/email/sendDigestEmail");
    const periods = await salesDailyPeriodsFor(istDay);
    const base = appUrl();

    const tables: DigestTable[] = [];
    for (const r of ROLES) {
      const rows = teamRows(r, s.blocks[r], person.id, s.teamOf, person.name);
      if (rows.length === 0) continue;
      tables.push({
        key: "my_team",
        title: r === "asm" ? "Team numbers · field (ASM)" : "Team numbers · calling (ISR)",
        columns: r === "asm" ? BLOCK_B_COLUMNS : BLOCK_C_COLUMNS,
        rows,
        textColumns: 1,
        groupHeaders: true,
        toneColumns: [r === "asm" ? BLOCK_B_PCT_COLUMN : BLOCK_C_PCT_COLUMN],
        note:
          `Yesterday = ${periods.yesterday.from}; MTD = ${periods.mtd.from} to ${periods.mtd.to}. ` +
          "Your team (↳) and the team subtotal, the same lines as in the management Sales email.",
      });
    }

    const { db } = await import("@/lib/db");
    const names = memberIds.length
      ? ((await db.execute(sql`
          SELECT id::text AS id, COALESCE(name, email) AS name FROM users
           WHERE id::text IN (${sql.join(memberIds.map((i) => sql`${i}`), sql`, `)})
           ORDER BY COALESCE(name, email)
        `)) as unknown as Array<{ id: string; name: string }>)
      : [];
    let total = 0;
    // One member at a time: each work list is a handful of queries, and a team
    // must not take every database connection at once.
    for (const m of names) {
      const items = (await workItems(m, sendDay)).filter((i) => i.list);
      const review = reviewRows(items);
      total += new Set(items.map((i) => `${i.list}|${i.lead_id}`)).size;
      tables.push({
        key: "my_team",
        title: `${m.name} · leads to review`,
        columns: ["Dealer", "City", "What", "Due", "Days (late / waiting / idle)"],
        rows: review.rows,
        rowLinks: review.links.map((l) =>
          l == null ? null : "lead" in l ? `${base}${leadHrefFor(role, l.lead)}` : `${base}${moreHref(l.more, m.id, role)}`,
        ),
        textColumns: 4,
        groupHeaders: true,
        empty: "Nothing overdue, past a limit, waiting for a visit or idle.",
      });
    }

    const first = person.name.split(/\s+/)[0] || person.name;
    return {
      ok: true,
      figures: {
        activity: [],
        backlog: [],
        wide: true,
        ctaHref: queueHrefFor(role),
        coveredDay: periods.yesterday.from,
        headline: [
          `${names.length} ${names.length === 1 ? "person" : "people"} in your team; ${total} lead${total === 1 ? "" : "s"} to review.`,
        ],
        masthead: {
          title: `My team · ${person.name}`,
          audience: `iTarang CRM to ${person.name}`,
          dataAsOf: istStamp(computedAt),
          eyebrow: "ITARANG · MY TEAM",
          dayHeading: dayLong(sendDay),
          intro:
            `Good morning ${first}. Your team's numbers cover ${dayLong(periods.yesterday.from)} and the month so far; ` +
            "below them, each person's leads to review today. Your own numbers are in your My day email.",
          firstBlockHint: "Open a dealer to see the lead",
          footer: "Sent by the iTarang CRM every working morning with My day, to anyone with people reporting to them.",
        },
        tables,
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[digest:my_team] build failed for ${person.id}:`, error);
    return { ok: false, figures: { activity: [], backlog: [] }, error };
  }
}

/** The settings preview / a plain `collect`: the first manager's mail. Never sent. */
async function collect(istDay: string): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    const [first] = await people({ roles: { inside_sales_rep: true, asm: true } });
    if (!first) return { ok: true, figures: { activity: [], backlog: [] } };
    return collectMyTeam(istDay, first);
  } catch (err) {
    return { ok: false, figures: { activity: [], backlog: [] }, error: err instanceof Error ? err.message : String(err) };
  }
}

async function collectDetail(): Promise<{ ok: boolean; detail: DigestDetail; error?: string }> {
  return { ok: true, detail: {} };
}

export const myTeamDigest: DigestKindDescriptor = {
  id: "my_team",
  label: "My team",
  description:
    "A second email, with My day, to each ISR or ASM who has people reporting to them: each member's " +
    "numbers and the team subtotal, then each member's leads to review. Uses My day's settings.",
  settingsKey: myDayDigest.settingsKey,
  settingsOf: "my_day",
  settingsHref: myDayDigest.settingsHref,
  ctaHref: "/inside-sales",
  ctaLabel: "Open my queue",
  sections: SECTIONS,
  slots: myDayDigest.slots,
  weekdays: myDayDigest.weekdays,
  defaults: myDayDigest.defaults,
  roleSwitches: myDayDigest.roleSwitches,
  perRecipient: { resolve: people, collect: collectMyTeam },
  subject: ({ dayLabel }) => `iTarang · My team — ${dayLabel}`,
  collect,
  collectDetail,
};
