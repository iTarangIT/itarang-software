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

export type MyDealerRow = DealerHealthRow & { scope: "own" | "team" | "other" };

export async function myDealerRows(user: { id: string; role: string }): Promise<{
    rows: MyDealerRow[];
    scope: ReturnType<typeof myDealersScope>;
}> {
    const scope = myDealersScope(user.role);
    const team = new Set(scope === "team" ? await getTeamMemberIds(user.id) : []);
    const whose = (ownerId: string | null): MyDealerRow["scope"] =>
        ownerId === user.id ? "own" : ownerId && team.has(ownerId) ? "team" : "other";
    const rows = (await listDealerHealth())
        .filter((r) => r.account_id)
        .map((r) => ({ ...r, scope: whose(r.owner_id) }))
        .filter((r) => r.scope === "own" || (scope === "team" && r.scope === "team") || scope === "all");
    return { rows, scope };
}
