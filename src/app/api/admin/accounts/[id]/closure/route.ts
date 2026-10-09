/**
 * Tracker ID 5 (E-332) — close a dealer account as "Lost / closed dealer"
 * with a reason, or reopen it.
 *
 * POST { action: "close", reason }  → the account moves to Dealer Health's
 *                                     "Closed" bucket (out of Dormant)
 * POST { action: "reopen" }         → back in the ordinary buckets
 *
 * The account's login, status and history are untouched (accountClosures.ts).
 */
import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ACCOUNT_CLOSE_ROLES, closeAccount, reopenAccount } from "@/lib/accounts/accountClosures";

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("action", [
    z.object({ action: z.literal("close"), reason: z.string().trim().min(3, "Give a reason.").max(500) }),
    z.object({ action: z.literal("reopen") }),
]);

export const POST = withErrorHandler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole([...ACCOUNT_CLOSE_ROLES]);
    const { id } = await ctx.params;
    const body = Body.parse(await req.json());
    if (body.action === "close") {
        const ok = await closeAccount(id, body.reason, user.id);
        if (!ok) throw Object.assign(new Error("Account not found"), { status: 404 });
    } else {
        await reopenAccount(id);
    }
    return successResponse({ account_id: id, closed: body.action === "close" });
});
