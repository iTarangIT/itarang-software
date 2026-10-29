// Tracker ID 199 — the review columns a manager reads on a team view of the
// ASM and Inside Sales queues: Last action (what + when), Next follow-up, Last
// visit (date + outcome), Days since last action, Time limit passed. Owner is
// the queue's own Owner column. Data: TEAM_REVIEW_SELECT + past_limits.

import type { TeamReviewFields } from "@/lib/leads/teamReviewSql";

export const TEAM_REVIEW_COLUMN_COUNT = 5;

const TH = "text-left px-4 py-3 font-semibold";
const TD = "px-4 py-3 align-top text-xs text-gray-700";

function pretty(v: string | null | undefined): string {
    return v ? v.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "";
}

function when(ts: string | null | undefined): string {
    if (!ts) return "";
    const d = new Date(ts);
    return Number.isNaN(d.getTime())
        ? ts
        : d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** A DATE column ("2026-10-28"): printed as-is, never shifted through UTC. */
function day(d: string | null | undefined): string {
    if (!d) return "";
    const [y, m, dd] = d.slice(0, 10).split("-");
    const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1];
    return mon ? `${dd} ${mon} ${y}` : d;
}

export function TeamReviewHeaders() {
    return (
        <>
            <th className={TH}>Last action</th>
            <th className={TH}>Next follow-up</th>
            <th className={TH}>Last visit</th>
            <th className={TH}>Days since action</th>
            <th className={TH}>Time limit passed</th>
        </>
    );
}

export function TeamReviewCells({
    row,
    outcomeLabel = pretty,
}: {
    row: TeamReviewFields & { past_limits?: string[] };
    /** How to name a visit outcome (the ASM queue passes its label map). */
    outcomeLabel?: (o: string) => string;
}) {
    const past = row.past_limits ?? [];
    return (
        <>
            <td className={TD}>
                {row.last_action || row.last_action_at ? (
                    <>
                        <div>{pretty(row.last_action) || "—"}</div>
                        <div className="text-gray-500">{when(row.last_action_at)}</div>
                    </>
                ) : (
                    <span className="text-gray-400">None</span>
                )}
            </td>
            <td className={TD}>{when(row.next_follow_up_at) || <span className="text-gray-400">None</span>}</td>
            <td className={TD}>
                {row.last_visit_date ? (
                    <>
                        <div>{day(row.last_visit_date)}</div>
                        {row.last_visit_outcome && <div className="text-gray-500">{outcomeLabel(row.last_visit_outcome)}</div>}
                    </>
                ) : (
                    <span className="text-gray-400">No visit</span>
                )}
            </td>
            <td className={`${TD} tabular-nums`}>{row.days_since_action ?? <span className="text-gray-400">—</span>}</td>
            <td className={TD}>
                {past.length ? (
                    <span className="text-rose-700">{past.join("; ")}</span>
                ) : (
                    <span className="text-gray-400">No</span>
                )}
            </td>
        </>
    );
}
