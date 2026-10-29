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
 * Team = the active people reporting to them in Reporting lines today
 * (currentTeamOf; a deactivated user with an open line is left out). ISRs and
 * ASMs both. A Sales Head or Sales Manager with people reporting to them gets
 * it too (29 Oct). The team subtotal adds each member for the days he was in
 * the team this month, leavers too, as the management email does (ID 155).
 * No company totals, no other teams, no ranking.
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
import { dayLong, istStamp, myDayDigest, people as myDayPeople, ROLES, sharedFor, workItems } from "./my-day";

const SECTIONS: DigestSection[] = myDayDigest.sections.filter((s) => s.key === "my_team");

/** ID 198 (29 Oct): managers outside My day's roles who also get My team. */
const MANAGER_ROLES = ["sales_head", "sales_manager"] as const;
const isManagerRole = (role: string | null | undefined) =>
  (MANAGER_ROLES as readonly string[]).includes((role ?? "").toLowerCase());

/** Today's team map without members who have been deactivated (leavers). */
async function activeTeamOf(teamOf: ReadonlyMap<string, string>): Promise<Map<string, string>> {
  const ids = [...teamOf.keys()];
  if (ids.length === 0) return new Map();
  const { db } = await import("@/lib/db");
  const rows = (await db.execute(sql`
    SELECT id::text AS id FROM users
     WHERE is_active = TRUE AND id::text IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
  `)) as unknown as Array<{ id: string }>;
  const active = new Set(rows.map((r) => r.id));
  return new Map([...teamOf].filter(([member]) => active.has(member)));
}

/**
 * Who gets My team: My day's people (the ISR / ASM roles switched on) plus
 * active Sales Heads and Sales Managers with an email, each with at least one
 * active person reporting to them today. Nothing when My day is off for both
 * roles: it is the same switch.
 */
async function people(settings: { roles: Record<string, boolean> }): Promise<DigestPerson[]> {
  if (!ROLES.some((r) => settings.roles[r])) return [];
  const everyone = await myDayPeople(settings);
  const { db } = await import("@/lib/db");
  const managers = (await db.execute(sql`
    SELECT id::text AS id, COALESCE(name, email) AS name, email, lower(role) AS role
      FROM users
     WHERE is_active = TRUE AND email IS NOT NULL AND trim(email) <> ''
       AND lower(role) IN (${sql.join(MANAGER_ROLES.map((r) => sql`${r}`), sql`, `)})
     ORDER BY name
  `)) as unknown as DigestPerson[];
  const { currentTeamOf } = await import("@/lib/users/team");
  const teamOf = await activeTeamOf(await currentTeamOf());
  return [...everyone, ...managers.map((r) => ({ ...r, email: r.email.trim() }))].filter(
    (p) => membersOf(teamOf, p.id).length > 0,
  );
}

/** Where a lead opens for the manager reading the mail. */
function leadHref(managerRole: string, leadId: string, leadHrefFor: (role: string, id: string) => string): string {
  return isManagerRole(managerRole) ? `/leads/${leadId}` : leadHrefFor(managerRole === "asm" ? "asm" : "inside_sales_rep", leadId);
}

/** The manager's own queue (the mail's button and "and N more"). */
function queueHref(managerRole: string): string {
  if (isManagerRole(managerRole)) return "/leads";
  return managerRole === "asm" ? "/asm" : "/inside-sales";
}

/** Where "and N more" opens, for the manager reading the mail. */
function moreHref(list: ReviewListKey, memberId: string, managerRole: string): string {
  // The one needs-action list a manager may open for their team (needsActionAccess).
  if (list === "field_visit") return `/admin/reports/needs-action/visit_overdue?spoc_id=${encodeURIComponent(memberId)}`;
  // ID 199: their queue (Leads for a Sales Head / Sales Manager), filtered to that team member (read-only).
  return `${queueHref(managerRole)}?member=${encodeURIComponent(memberId)}`;
}

/** One manager's mail. Exported for scripts/verify-sales-daily.ts --my-team. */
export async function collectMyTeam(
  istDay: string,
  person: DigestPerson,
): Promise<{ ok: boolean; figures: DigestFigures; error?: string }> {
  try {
    const computedAt = new Date();
    const managerRole = (person.role ?? "").toLowerCase();
    const sendDay = addDays(istDay, 1);
    const s = await sharedFor(istDay);
    // Listed members: today's team without leavers. The subtotal (below) adds
    // the dated team, leavers included, as the management email does.
    const teamOf = await activeTeamOf(s.teamOf);
    const memberIds = membersOf(teamOf, person.id);
    const { leadHrefFor } = await import("@/lib/leads/newOwnerNotice");
    const { appUrl } = await import("@/lib/email/sendDigestEmail");
    const { datedTeamGroupsFor } = await import("../datedTeamGroups");
    const periods = await salesDailyPeriodsFor(istDay);
    const base = appUrl();

    const tables: DigestTable[] = [];
    for (const r of ROLES) {
      const teamGroups = await datedTeamGroupsFor({
        role: r,
        blocks: s.blocks[r],
        teamOf: s.teamOf,
        outsideNames: new Map([[person.id, person.name]]),
        periods,
        userTargets: s.targets,
        only: [person.id],
        logTag: "digest:my_team",
      });
      const rows = teamRows(r, s.blocks[r], person.id, teamOf, person.name, teamGroups);
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
    // The lead page opens a lead only when the manager or a team member owns it
    // (leadVisibleTo, ID 155). A visit on a lead owned outside the team is
    // listed without a link rather than with one that is refused.
    const owners = [person.id, ...memberIds];
    const openable = async (ids: string[]): Promise<Set<string>> => {
      if (ids.length === 0) return new Set();
      const rows = (await db.execute(sql`
        SELECT id FROM dealer_leads
         WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
           AND current_owner_id IN (${sql.join(owners.map((o) => sql`${o}`), sql`, `)})
      `)) as unknown as Array<{ id: string }>;
      return new Set(rows.map((r) => r.id));
    };
    for (const m of names) {
      const items = (await workItems(m, sendDay)).filter((i) => i.list);
      const review = reviewRows(items);
      const canOpen = await openable([...new Set(review.links.flatMap((l) => (l && "lead" in l ? [l.lead] : [])))]);
      total += new Set(items.map((i) => `${i.list}|${i.lead_id}`)).size;
      tables.push({
        key: "my_team",
        title: `${m.name} · leads to review`,
        columns: ["Dealer", "City", "What", "Due", "Days (late / waiting / idle)"],
        rows: review.rows,
        rowLinks: review.links.map((l) =>
          l == null
            ? null
            : "lead" in l
              ? canOpen.has(l.lead)
                ? `${base}${leadHref(managerRole, l.lead, leadHrefFor)}`
                : null
              : `${base}${moreHref(l.more, m.id, managerRole)}`,
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
        ctaHref: queueHref(managerRole),
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
    "A second email, with My day, to each ISR, ASM, Sales Head or Sales Manager who has people reporting to them: each member's " +
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
