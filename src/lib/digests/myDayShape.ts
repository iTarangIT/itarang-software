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
import {
    formatRepValue,
    repBlockTableRows,
    yesterdayMetricsOf,
    type RepBlock,
    type TeamGroups,
    type TeamOf,
} from "./salesDailyBlocks";

type Rows = Array<Array<string | number>>;
type Role = "asm" | "inside_sales_rep";

/** The person's own row in Block B (ASM) or C (ISR); [] when they are not in it. */
export function personRows(role: Role, blocks: RepBlock[], personId: string): Rows {
    const mine = blocks.filter((b) => b.id === personId);
    return mine.length ? repBlockTableRows(role, mine) : [];
}

/**
 * ID 194 #1 (Kartik, 18 Oct) — the person's Yesterday figures against the same
 * weekday a week earlier: one row per metric their block shows for Yesterday
 * ("Calls", Yesterday, Same day last week). `wkBlocks` are buildRepBlocks run
 * with the same-day-last-week window as their "y". [] when they are in neither.
 */
export function sameDayLastWeekRows(role: Role, yBlocks: RepBlock[], wkBlocks: RepBlock[], personId: string): Rows {
    const y = yBlocks.find((b) => b.id === personId);
    const wk = wkBlocks.find((b) => b.id === personId);
    if (!y && !wk) return [];
    // Missing from one window's list = nothing of theirs that day.
    const val = (b: RepBlock | undefined, m: Parameters<typeof formatRepValue>[0]) =>
        formatRepValue(m, b ? (b.values[m]?.y ?? null) : 0);
    return yesterdayMetricsOf(role).map(({ label, metric }) => [label, val(y, metric), val(wk, metric)]);
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
 * block (an ASM lead managing ISRs), the management email groups the members
 * under "<manager> · team" with their own subtotal (24 Oct, outsideManagers);
 * ID 198 prints the same lines, so a team subtotal is always there. [] when no
 * member is in this block. With `teamGroups` (ID 198, 29 Oct) the subtotal adds
 * the manager's dated group, as the management email's does (ID 155).
 */
export function teamRows(
    role: Role,
    blocks: RepBlock[],
    managerId: string,
    teamOf: TeamOf,
    managerName?: string,
    teamGroups?: TeamGroups,
): Rows {
    const members = new Set(membersOf(teamOf, managerId));
    const inBlock = blocks.filter((b) => members.has(b.id));
    if (inBlock.length === 0) return [];
    const manager = blocks.find((b) => b.id === managerId);
    const group = manager ? [manager, ...inBlock] : inBlock;
    const outside = manager ? undefined : new Map([[managerId, managerName ?? "Team"]]);
    const rows = repBlockTableRows(role, group, teamOf, teamGroups, outside);
    // The block's "Total" repeats the team subtotal. Drop it.
    if (group.length > 1 && rows.length && rows[rows.length - 1][0] === "Total") rows.pop();
    return rows;
}

/** ID 198 — the lists a manager reviews per member, in the order they print. */
export const REVIEW_LISTS = [
    { key: "follow_up", label: "Overdue follow-ups" },
    { key: "visit", label: "Visits due or overdue" },
    { key: "limit", label: "Time limits passed" },
    { key: "field_visit", label: "Waiting for a field visit" },
    { key: "idle", label: "Idle leads" },
] as const;
export type ReviewListKey = (typeof REVIEW_LISTS)[number]["key"];

/**
 * ID 198 — one member's leads to review, list by list (REVIEW_LISTS order):
 * a header row per list that has anything, up to `cap` leads (oldest first),
 * then "… and N more" when it has more. `links` is aligned with `rows`: the
 * lead's id for a lead row, the list key for an "and N more" row, null for a
 * header. [] when the member has nothing on any list.
 */
export function reviewRows(
    items: WorkItem[],
    cap = 10,
): { rows: Rows; links: Array<{ lead: string } | { more: ReviewListKey } | null> } {
    const rows: Rows = [];
    const links: Array<{ lead: string } | { more: ReviewListKey } | null> = [];
    for (const list of REVIEW_LISTS) {
        const seen = new Set<string>();
        const mine = items
            .filter((i) => i.list === list.key && !seen.has(i.lead_id) && seen.add(i.lead_id))
            .sort((a, b) => b.days - a.days || a.dealer.localeCompare(b.dealer));
        if (mine.length === 0) continue;
        rows.push([`${list.label} (${mine.length})`, "", "", "", ""]);
        links.push(null);
        for (const i of mine.slice(0, cap)) {
            rows.push([i.dealer, i.city?.trim() || "—", i.what, i.due ?? "—", i.days]);
            links.push({ lead: i.lead_id });
        }
        if (mine.length > cap) {
            // Not all-blank, so it renders as a linked row rather than a group header.
            rows.push([`… and ${mine.length - cap} more`, "", "Open the full list", "", ""]);
            links.push({ more: list.key });
        }
    }
    return { rows, links };
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
    /** ID 198 — which review list it belongs to in the My team email; absent = My day only. */
    list?: ReviewListKey;
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
