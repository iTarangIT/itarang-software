// GET  /api/admin/dealer-verifications/[dealerId]/lead-match
// POST /api/admin/dealer-verifications/[dealerId]/lead-match
//
// Tracker ID 214 (decided 2 Nov, Kartik): Dealer Validation shows the lead
// this onboarding sits on — name, owner, status, how it was matched, who gets
// the credit — and Admin confirms or corrects it before approval:
//   { action: "confirm" }
//   { action: "change_lead", leadId }      another lead (e.g. a possible match)
//   { action: "not_same_dealer" }          unlink; create a Direct onboarding lead
//   { action: "change_credit", userId }    userId null = nobody gets the credit
//   { action: "find_again" }               re-run the match ladder
// Approval waits for Confirm (approve/route.ts → leadMatchApprovalBlock).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireDealerValidationReader, requireSalesHead } from "@/lib/auth/requireSalesHead";
import { LeadMatchError, applyLeadMatchAction, loadLeadMatchPanel } from "@/lib/onboarding/leadMatch";

type RouteContext = { params: Promise<{ dealerId: string }> };

export async function GET(_req: NextRequest, context: RouteContext) {
    const { dealerId } = await context.params;
    const auth = await requireDealerValidationReader(dealerId);
    if (!auth.ok) return auth.response;
    try {
        return NextResponse.json({ success: true, data: await loadLeadMatchPanel(dealerId) });
    } catch (err) {
        console.error("[lead-match] GET failed", err);
        return NextResponse.json({ success: false, message: "Could not load the lead." }, { status: 500 });
    }
}

const Body = z.discriminatedUnion("action", [
    z.object({ action: z.literal("confirm") }),
    z.object({ action: z.literal("change_lead"), leadId: z.string().trim().min(1) }),
    z.object({ action: z.literal("not_same_dealer") }),
    z.object({ action: z.literal("change_credit"), userId: z.string().trim().min(1).nullable() }),
    z.object({ action: z.literal("find_again") }),
]);

export async function POST(req: NextRequest, context: RouteContext) {
    const auth = await requireSalesHead();
    if (!auth.ok) return auth.response;
    const { dealerId } = await context.params;
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ success: false, message: "Unknown action." }, { status: 400 });
    }
    try {
        await applyLeadMatchAction(dealerId, auth.user.id, parsed.data);
        return NextResponse.json({ success: true, data: await loadLeadMatchPanel(dealerId) });
    } catch (err) {
        if (err instanceof LeadMatchError) {
            return NextResponse.json({ success: false, message: err.message }, { status: err.status });
        }
        console.error("[lead-match] POST failed", err);
        return NextResponse.json({ success: false, message: "Could not save. Try again." }, { status: 500 });
    }
}
