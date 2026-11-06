/**
 * "My dealers" (tracker ID 5, E-358): the dealer accounts a user may see, with
 * their health row — the user's own, an ASM's direct reports' too, and every
 * account for Sales Head / CEO / Partner (quotationAccess.ts myDealersScope).
 * Shared by GET /api/dealer-accounts/mine and the WhatsApp assistant's
 * my_dealers tool (ID 211), so both always offer exactly the same accounts.
 */
import { listDealerHealth, type DealerHealthRow } from "@/lib/dealers/accountHealth";
import { myDealersScope } from "@/lib/accounts/quotationAccess";
import { getTeamMemberIds } from "@/lib/users/team";
import { mayLogAccountVisit } from "@/lib/visits/verifiedCapture";

export type MyDealerRow = DealerHealthRow & {
    scope: "own" | "team" | "other";
    /** ID 210: the owner or the owner's manager may log a visit on this counter. */
    can_log_visit: boolean;
};

export async function myDealerRows(user: { id: string; role: string }): Promise<{
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
    const rows = (await listDealerHealth())
        .filter((r) => r.account_id)
        .map((r) => ({
            ...r,
            scope: whose(r.owner_id),
            can_log_visit: mayLogAccountVisit({ userId: user.id, ownerId: r.owner_id, teamIds }),
        }))
        .filter((r) => r.scope === "own" || (scope === "team" && r.scope === "team") || scope === "all");
    return { rows, scope };
}
