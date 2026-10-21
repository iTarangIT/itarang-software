// "My day" (tracker ID 194) — the pure half: which rows of the management
// email's Blocks B / C a person sees, and their target lines.
//
// The decision: "numbers must equal the person's row in the management email
// and their Performance page". So nothing here computes a number. A person's
// row is the SAME repBlockTableRows() row the management email prints for
// them, cut out of the same RepBlock list; a manager's team table is the same
// function run over the manager and their members, so the "Team subtotal"
// line is the one printed under that manager in the management email.
//
// Pure (no db) — unit tested in __tests__/myDayShape.test.ts.

import { pctOfTarget } from "./salesDailyBlockA";
import { repBlockTableRows, TEAM_MEMBER_PREFIX, TEAM_SUBTOTAL_PREFIX, type RepBlock, type TeamOf } from "./salesDailyBlocks";

type Rows = Array<Array<string | number>>;
type Role = "asm" | "inside_sales_rep";

/** The person's own row in Block B (ASM) or C (ISR); [] when they are not in it. */
export function personRows(role: Role, blocks: RepBlock[], personId: string): Rows {
    const mine = blocks.filter((b) => b.id === personId);
    return mine.length ? repBlockTableRows(role, mine) : [];
}

/** Member id → their manager, for the people who report to `managerId`. */
export function membersOf(teamOf: TeamOf, managerId: string): string[] {
    const out: string[] = [];
    for (const [member, manager] of teamOf) if (manager === managerId && member !== managerId) out.push(member);
    return out;
}

/**
 * The manager's team table for one role: the manager's own row (when they are
 * in this block), each member (↳) and the "Team subtotal" — exactly the lines
 * under that manager in the management email. When the manager is not in this
 * block (an ASM lead managing ISRs), only the members' rows are listed — the
 * management email lists them ungrouped with no total of their own, so (ID
 * 194, 18 Oct rework 1) neither does My day. [] when no member is in this block.
 */
export function teamRows(role: Role, blocks: RepBlock[], managerId: string, teamOf: TeamOf): Rows {
    const members = new Set(membersOf(teamOf, managerId));
    const inBlock = blocks.filter((b) => members.has(b.id));
    if (inBlock.length === 0) return [];
    const manager = blocks.find((b) => b.id === managerId);
    const group = manager ? [manager, ...inBlock] : inBlock;
    const rows = repBlockTableRows(role, group, teamOf);
    // With the manager present the block's "Total" repeats the subtotal; without
    // them it is a cross-role total the management email does not print. Drop it.
    if (group.length > 1 && rows.length && rows[rows.length - 1][0] === "Total") rows.pop();
    return rows;
}

/** One team member's overdue work, for the manager's "My team · overdue" table. */
export type MemberOverdue = { id: string; name: string; followUps: number; visits: number };

/**
 * ID 194 — the manager's team: each member's overdue follow-ups and overdue
 * visits (the same rules as each member's own work list: a follow-up dated
 * before today, a scheduled visit dated before today), the manager first when
 * they are in it, then a team subtotal. [] for no members.
 */
export function teamOverdueRows(managerId: string, people: MemberOverdue[]): Rows {
    if (people.length === 0) return [];
    const ordered = [...people].sort((a, b) =>
        a.id === managerId ? -1 : b.id === managerId ? 1 : a.name.localeCompare(b.name),
    );
    const rows: Rows = ordered.map((p) => [p.id === managerId ? p.name : `${TEAM_MEMBER_PREFIX}${p.name}`, p.followUps, p.visits]);
    if (ordered.length > 1) {
        const manager = ordered.find((p) => p.id === managerId);
        rows.push([
            manager ? `${TEAM_SUBTOTAL_PREFIX}${manager.name}` : "Team subtotal",
            ordered.reduce((s, p) => s + p.followUps, 0),
            ordered.reduce((s, p) => s + p.visits, 0),
        ]);
    }
    return rows;
}

export type TargetLine = {
    label: string;
    /** "per_day" targets are a daily rate; everything else is a month-to-date count. */
    kind: "count" | "money" | "per_day";
    /** Pro-rated MTD target (per-day rate for per_day). */
    target: number;
    /** MTD actual (running daily average for per_day); null = not measured. */
    actual: number | null;
};

/** "Target to date vs actual" rows: Metric | Target to date | Actual | % of target. */
export function targetRows(lines: TargetLine[]): Rows {
    const fmt = (v: number, kind: TargetLine["kind"]) =>
        kind === "money"
            ? `₹${Math.round(v).toLocaleString("en-IN")}`
            : kind === "per_day"
              ? `${Math.round(v * 10) / 10} a day`
              : Math.round(v);
    return lines.map((l) => {
        const p = pctOfTarget(l.actual, l.target);
        return [
            l.label,
            fmt(l.target, l.kind),
            l.actual == null ? "—" : fmt(l.actual, l.kind),
            p == null ? "—" : `${p}%`,
        ];
    });
}

export type WorkItem = {
    lead_id: string;
    dealer: string;
    city: string | null;
    what: string;
    /** YYYY-MM-DD, or null for an idle lead (no due date). */
    due: string | null;
    /** Days past due (or idle days for an idle lead). */
    days: number;
};

/**
 * One list, most urgent first: dated items oldest-due first, then idle leads
 * by idle days. A lead appears once per kind of work ("what").
 */
export function workListRows(items: WorkItem[], cap = 30): { rows: Rows; leadIds: string[]; more: number } {
    const seen = new Set<string>();
    const unique = items.filter((i) => {
        const k = `${i.lead_id}|${i.what}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
    unique.sort((a, b) => {
        if (a.due && b.due) return a.due.localeCompare(b.due) || a.dealer.localeCompare(b.dealer);
        if (a.due) return -1;
        if (b.due) return 1;
        return b.days - a.days;
    });
    const shown = unique.slice(0, cap);
    return {
        rows: shown.map((i) => [i.dealer, i.city?.trim() || "—", i.what, i.due ?? "—", i.days]),
        leadIds: shown.map((i) => i.lead_id),
        more: unique.length - shown.length,
    };
}
