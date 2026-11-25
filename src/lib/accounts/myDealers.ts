/**
 * "My dealers" (tracker ID 5, E-358): the dealer accounts a user may see, with
 * their health row — the user's own, an ASM's direct reports' too, and every
 * account for Sales Head / CEO / Partner (quotationAccess.ts myDealersScope).
 * Shared by GET /api/dealer-accounts/mine and the WhatsApp assistant's
 * my_dealers tool (ID 211), so both always offer exactly the same accounts.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { listDealerHealth, type DealerHealthRow } from "@/lib/dealers/accountHealth";
import { myDealersScope } from "@/lib/accounts/quotationAccess";
import { getTeamMemberIds } from "@/lib/users/team";
import { mayLogAccountVisit } from "@/lib/visits/verifiedCapture";

export type MyDealerRow = DealerHealthRow & {
    scope: "own" | "team" | "other";
    /** ID 210: the owner or the owner's manager may log a visit on this counter. */
    can_log_visit: boolean;
    /** ID 241-3: the latest DONE visit to this dealer account (IST date), or null. */
    last_visit_date: string | null;
    /** ID 241-3: no done visit in the last 30 days (a closed dealer is never flagged). */
    not_visited_30: boolean;
};

/** ID 241-3: the "Not visited in 30 days" rule. Pure (tests and the screen). */
export const NOT_VISITED_DAYS = 30;
export function notVisitedIn30(lastVisitDate: string | null, todayIst: string, bucket?: string): boolean {
    if (bucket === "closed") return false;
    if (!lastVisitDate) return true;
    const days = (Date.parse(`${todayIst}T00:00:00Z`) - Date.parse(`${lastVisitDate.slice(0, 10)}T00:00:00Z`)) / 86_400_000;
    return days > NOT_VISITED_DAYS;
}

/**
 * The latest done visit per dealer ACCOUNT (lead_visits.account_id, E-363; read through
 * to_jsonb so a database without it simply has none). Fail-soft: a failed read shows no
 * last visit rather than breaking My dealers.
 */
async function lastVisitByAccount(): Promise<Map<string, string>> {
    try {
        const rows = (await db.execute(sql`
            SELECT to_jsonb(v) ->> 'account_id' AS account_id, MAX(v.actual_visit_date)::text AS last_visit
              FROM lead_visits v
             WHERE v.visit_status = 'visited' AND (to_jsonb(v) ->> 'account_id') IS NOT NULL
             GROUP BY 1
        `)) as unknown as Array<{ account_id: string; last_visit: string | null }>;
        return new Map(rows.filter((r) => r.last_visit).map((r) => [r.account_id, r.last_visit!]));
    } catch (err) {
        console.warn("[myDealers] last visit read failed", err instanceof Error ? err.message : err);
        return new Map();
    }
}

export async function myDealerRows(
    user: { id: string; role: string },
    /**
     * 25 Nov item 9: the My dealers SCREEN also lists, for an ASM, every other
     * onboarded dealer (scope "other") so they can log a visit there. The
     * WhatsApp assistant keeps the owner / team list.
     */
    opts?: { includeVisitable?: boolean },
): Promise<{
    rows: MyDealerRow[];
    scope: ReturnType<typeof myDealersScope>;
}> {
    const scope = myDealersScope(user.role);
    // Direct reports, for everyone: the visit rule (ID 210) lets any manager
    // log on a report's counter, whatever the list scope.
    const teamIds = await getTeamMemberIds(user.id);
    const team = new Set(scope === "team" ? teamIds : []);
    const whose = (ownerId: string | null): MyDealerRow["scope"] =>
        ownerId === user.id ? "own" : ownerId && team.has(ownerId) ? "team" : "other";
    const [health, lastVisit] = await Promise.all([listDealerHealth(), lastVisitByAccount()]);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const rows = health
        .filter((r) => r.account_id)
        .map((r) => {
            const last = lastVisit.get(r.account_id!) ?? null;
            return {
                ...r,
                scope: whose(r.owner_id),
                can_log_visit: mayLogAccountVisit({ userId: user.id, ownerId: r.owner_id, teamIds, role: user.role }),
                last_visit_date: last,
                not_visited_30: notVisitedIn30(last, today, r.bucket),
            };
        })
        .filter(
            (r) =>
                r.scope === "own" ||
                (scope === "team" && r.scope === "team") ||
                scope === "all" ||
                (!!opts?.includeVisitable && r.can_log_visit),
        );
    return { rows, scope };
}
