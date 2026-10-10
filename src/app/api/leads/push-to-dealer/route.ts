// Tracker ID 33 — POST /api/leads/push-to-dealer
//
// Bulk version of the Step-1 "Dealer mobile number" push: the iTarang team
// (house-dealer login, or an internal role) selects several house-dealer
// leads on the lead list, types ONE dealer mobile, and every selected lead
// moves to that dealer in one go. Same rules as the Step-1 push in
// /api/leads/create:
//   • only leads still with the house dealer (one push per file — moving it
//     again needs an admin);
//   • the dealer must be active (findActiveDealerByMobile);
//   • finance leads only to a finance-enabled dealer.
// Leads that break a rule are skipped and reported back; the rest move.

import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { auditLogs, leads } from "@/lib/db/schema";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { findActiveDealerByMobile, houseDealerCode } from "@/lib/leads/dealerByMobile";
import { canUsePushToDealer, NO_ACTIVE_DEALER_MESSAGE } from "@/lib/leads/pushToDealer";

export const dynamic = "force-dynamic";

const MAX_LEADS = 100;

const bodySchema = z.object({
    leadIds: z.array(z.string().min(1)).min(1).max(MAX_LEADS),
    dealer_mobile: z.string().min(1).max(20),
});

const FINANCE_METHODS = ["finance", "other_finance", "dealer_finance"];

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireAuth();
    const house = await houseDealerCode();
    if (!house) return errorResponse("The iTarang house dealer is not set up on this environment.", 500);
    if (!canUsePushToDealer({ role: user.role, dealerId: user.dealer_id, houseDealerCode: house })) {
        return errorResponse("Only the iTarang team can push leads to a dealer.", 403);
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
        return errorResponse(`Select between 1 and ${MAX_LEADS} leads and enter the dealer mobile.`, 400);
    }
    const leadIds = Array.from(new Set(parsed.data.leadIds));

    const found = await findActiveDealerByMobile(parsed.data.dealer_mobile);
    if (found.status !== "found") {
        const why =
            found.status === "invalid_mobile"
                ? "Enter a 10-digit dealer mobile number"
                : found.status === "ambiguous"
                  ? "More than one active dealer uses this number — ask an admin to fix the dealer records"
                  : NO_ACTIVE_DEALER_MESSAGE;
        return errorResponse(why, 422);
    }
    const target = found.dealer;

    const rows = await db
        .select({ id: leads.id, dealerId: leads.dealer_id, paymentMethod: leads.payment_method })
        .from(leads)
        .where(inArray(leads.id, leadIds));
    const byId = new Map(rows.map((r) => [r.id, r]));

    const skipped: { leadId: string; reason: string }[] = [];
    const movable: string[] = [];
    for (const id of leadIds) {
        const r = byId.get(id);
        if (!r) skipped.push({ leadId: id, reason: "Lead not found" });
        else if (r.dealerId !== house)
            skipped.push({ leadId: id, reason: "Already belongs to another dealer — moving it again needs an admin" });
        else if (FINANCE_METHODS.includes(r.paymentMethod ?? "") && !target.financeEnabled)
            skipped.push({ leadId: id, reason: `${target.name} is not enabled for finance leads` });
        else movable.push(id);
    }

    const pushed: string[] = [];
    if (movable.length) {
        const now = new Date();
        await db.transaction(async (tx) => {
            // dealer_id = house in the WHERE as well, so a lead someone else
            // moved between the read above and now is left alone.
            const moved = await tx
                .update(leads)
                .set({
                    dealer_id: target.dealerId,
                    assignment_status: "assigned",
                    dealer_assigned_at: now,
                    dealer_assigned_by: user.id,
                    updated_at: now,
                })
                .where(and(inArray(leads.id, movable), eq(leads.dealer_id, house)))
                .returning({ id: leads.id });
            pushed.push(...moved.map((m) => m.id));

            if (pushed.length) {
                await tx.insert(auditLogs).values(
                    pushed.map((leadId, i) => ({
                        id: `AUDIT-${Date.now()}-push-${i}`,
                        entity_type: "lead",
                        entity_id: leadId,
                        action: "LEAD_PUSHED_TO_DEALER",
                        changes: {
                            from_dealer_id: house,
                            to_dealer_id: target.dealerId,
                            to_dealer_name: target.name,
                            via: "bulk_dealer_mobile",
                        },
                        performed_by: user.id,
                        timestamp: now,
                    })),
                );
            }
        });
        for (const id of movable) {
            if (!pushed.includes(id)) {
                skipped.push({ leadId: id, reason: "Already belongs to another dealer — moving it again needs an admin" });
            }
        }
    }

    // Tell the dealer on WhatsApp, one notice per lead (same as the Step-1
    // push). Best-effort, never throws — the move is already committed.
    if (pushed.length) {
        const { notifyDealerOfPushedLead } = await import("@/lib/whatsapp/pushedLeadNotice");
        for (const id of pushed) await notifyDealerOfPushedLead(id);
    }

    return successResponse({
        dealer: { dealerId: target.dealerId, name: target.name },
        pushed,
        skipped,
    });
});
