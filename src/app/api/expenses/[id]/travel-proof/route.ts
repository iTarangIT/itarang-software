// GET /api/expenses/[id]/travel-proof — tracker ID 197: the Day evidence of a
// Travel / Vehicle/Fuel claim, one block per claimed day — the verdict and
// note given at submit, and the day's visits (verified or not, stamped photo,
// distance from the shop when known, in or outside territory), first and last
// visit time, cities and calls (context only). Only the CEO and the person who
// submitted the claim.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { expenseSubmissions, users } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { mayReadTravelProof } from "@/lib/expenses/travelProof";
import { claimDaysFor, dayEvidence } from "@/lib/expenses/travelProofStore";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireAuth();
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(id ?? "")) return errorResponse("Claim not found", 404);
    const [claim] = await db
        .select({
            id: expenseSubmissions.id,
            submitted_by: expenseSubmissions.submitted_by,
            category: expenseSubmissions.category,
            amount: expenseSubmissions.amount,
            submitter_name: users.name,
        })
        .from(expenseSubmissions)
        .leftJoin(users, eq(users.id, expenseSubmissions.submitted_by))
        .where(eq(expenseSubmissions.id, id))
        .limit(1);
    if (!claim) return errorResponse("Claim not found", 404);
    if (!mayReadTravelProof(user, claim.submitted_by)) {
        return errorResponse("Only the CEO and the person who submitted this claim can see its travel proof.", 403);
    }

    const days = (await claimDaysFor([claim.id])).get(claim.id) ?? [];
    const evidence = [];
    for (const d of days) {
        evidence.push({ ...(await dayEvidence(claim.submitted_by, d.day, { withDistance: true })), claimed: d });
    }
    return successResponse({
        claim: { id: claim.id, category: claim.category, amount: claim.amount, submitter_name: claim.submitter_name },
        days: evidence,
    });
});
