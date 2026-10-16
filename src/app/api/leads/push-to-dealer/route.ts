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
//   • finance leads only to a finance-enabled dealer;
//   • ID 33: never once the customer has signed consent (checkPush);
//   • ID 33: a reason is required and goes on every lead's push history, like
//     the single CRM push; the old dealer's reserved coupon goes back to their
//     pool and their salesperson comes off the file (detachFromOldDealer).
// Leads that break a rule are skipped and reported back; the rest move.
//
// 16 Oct (ID 33 / 182): the house pushes a file ONCE. A file that carries a
// push is skipped here ("Moving it again needs an admin") — the second move is
// Admin's, through the CRM push on the file. Every row records the reason and
// the person's own login (each iTarang team member has a login under the
// house code), and the dealer is told with the reason.

import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { auditLogs, leads } from "@/lib/db/schema";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { findActiveDealerById, findActiveDealerByMobile, houseDealerCode } from "@/lib/leads/dealerByMobile";
import {
    canUsePushToDealer,
    checkPush,
    isHouseLogin,
    NO_ACTIVE_DEALER_MESSAGE,
    PUSH_REASON_MAX,
    PUSH_REASON_MIN,
    PUSH_REASON_REQUIRED_MESSAGE,
} from "@/lib/leads/pushToDealer";
import {
    dealerDisplayNames,
    detachAuditChanges,
    detachFromOldDealer,
    LEAD_PUSHED_TO_DEALER,
    logPushCouponRelease,
    pushedBeforeLeadIds,
    signedConsentLeadIds,
    type DetachResult,
} from "@/lib/leads/pushGuards";

export const dynamic = "force-dynamic";

const MAX_LEADS = 100;

const bodySchema = z.object({
    leadIds: z.array(z.string().min(1)).min(1).max(MAX_LEADS),
    // 14 Oct: the dealer picked from the name/mobile search (its dealer code),
    // or a typed dealer mobile as before. One of the two.
    dealer_id: z.string().min(1).max(64).optional(),
    dealer_mobile: z.string().min(1).max(20).optional(),
    // ID 33: required, same rule as the single CRM push.
    reason: z.string().trim().min(PUSH_REASON_MIN, PUSH_REASON_REQUIRED_MESSAGE).max(PUSH_REASON_MAX),
});

/** The active dealer the leads go to: by picked dealer code, else by mobile. */
async function resolveTarget(body: { dealer_id?: string; dealer_mobile?: string }) {
    if (body.dealer_id) {
        const d = await findActiveDealerById(body.dealer_id);
        return d ?? { error: NO_ACTIVE_DEALER_MESSAGE, status: 422 };
    }
    if (!body.dealer_mobile) return { error: "Pick the dealer to push to.", status: 400 };
    const found = await findActiveDealerByMobile(body.dealer_mobile);
    if (found.status === "found") return found.dealer;
    const error =
        found.status === "invalid_mobile"
            ? "Enter a 10-digit dealer mobile number"
            : found.status === "ambiguous"
              ? "More than one active dealer uses this number — ask an admin to fix the dealer records"
              : NO_ACTIVE_DEALER_MESSAGE;
    return { error, status: 422 };
}

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireAuth();
    const house = await houseDealerCode();
    if (!house) return errorResponse("The iTarang house dealer is not set up on this environment.", 500);
    if (!canUsePushToDealer({ role: user.role, dealerId: user.dealer_id, houseDealerCode: house })) {
        return errorResponse("Only the iTarang team can push leads to a dealer.", 403);
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
        const reasonIssue = parsed.error.issues.find((i) => i.path[0] === "reason");
        return errorResponse(
            reasonIssue
                ? PUSH_REASON_REQUIRED_MESSAGE
                : `Select between 1 and ${MAX_LEADS} leads and pick a dealer.`,
            400,
        );
    }
    const leadIds = Array.from(new Set(parsed.data.leadIds));
    const reason = parsed.data.reason;

    const target = await resolveTarget(parsed.data);
    if ("error" in target) return errorResponse(target.error, target.status);

    const rows = await db
        .select({ id: leads.id, dealerId: leads.dealer_id, paymentMethod: leads.payment_method })
        .from(leads)
        .where(inArray(leads.id, leadIds));
    const byId = new Map(rows.map((r) => [r.id, r]));
    // ID 33: consent gate — a signed consent pins the file to its dealer.
    // One push per file: a lead that already carries a push never moves again
    // from this list, even if it is back with the house dealer.
    const [signed, pushedBefore] = await Promise.all([
        signedConsentLeadIds(leadIds),
        pushedBeforeLeadIds(leadIds),
    ]);
    const actorIsHouseLogin = isHouseLogin({ role: user.role, dealerId: user.dealer_id, houseDealerCode: house });
    const names = await dealerDisplayNames([house, ...rows.map((r) => r.dealerId ?? "").filter(Boolean)]);

    const skipped: { leadId: string; reason: string }[] = [];
    const movable: string[] = [];
    for (const id of leadIds) {
        const r = byId.get(id);
        if (!r) {
            skipped.push({ leadId: id, reason: "Lead not found" });
            continue;
        }
        // ID 33 / 182: the one push rule every path uses (consent, one push per
        // file, a dealer's own lead never moves, same dealer, finance).
        const verdict = checkPush({
            actorRole: user.role,
            actorIsHouseLogin,
            via: "bulk_dealer_mobile",
            currentDealerId: r.dealerId,
            currentDealerName: (r.dealerId ? names.get(r.dealerId) : null) ?? null,
            houseDealerCode: house,
            consentSigned: signed.has(id),
            pushedBefore: pushedBefore.has(id),
            paymentMethod: r.paymentMethod,
            target,
        });
        if (!verdict.ok) skipped.push({ leadId: id, reason: verdict.message });
        else movable.push(id);
    }

    const pushed: string[] = [];
    const detachedById = new Map<string, DetachResult>();
    if (movable.length) {
        const now = new Date();
        const fromOf = (leadId: string) => byId.get(leadId)?.dealerId ?? house;
        await db.transaction(async (tx) => {
            // dealer_id = the dealer the file had when checked, in the WHERE as
            // well, so a lead someone else moved in between is left alone.
            for (const leadId of movable) {
                const moved = await tx
                    .update(leads)
                    .set({
                        dealer_id: target.dealerId,
                        assignment_status: "assigned",
                        dealer_assigned_at: now,
                        dealer_assigned_by: user.id,
                        // 14 Oct: a delete by the dealer it leaves does not follow the file —
                        // the dealer receiving it starts with it on their list.
                        deleted_by_dealer_at: null,
                        deleted_by_dealer_user: null,
                        updated_at: now,
                    })
                    .where(and(eq(leads.id, leadId), eq(leads.dealer_id, fromOf(leadId))))
                    .returning({ id: leads.id });
                if (moved.length) pushed.push(leadId);
            }

            // ID 33: release the old dealer's (house or dealer) reserved coupon
            // and clear its salesperson on every lead that moved.
            for (const leadId of pushed) detachedById.set(leadId, await detachFromOldDealer(tx, leadId));

            if (pushed.length) {
                await tx.insert(auditLogs).values(
                    pushed.map((leadId, i) => ({
                        id: `AUDIT-${Date.now()}-push-${i}`,
                        entity_type: "lead",
                        entity_id: leadId,
                        action: LEAD_PUSHED_TO_DEALER,
                        changes: {
                            from_dealer_id: fromOf(leadId),
                            from_dealer_name: names.get(fromOf(leadId)) ?? fromOf(leadId),
                            repush: fromOf(leadId) !== house,
                            to_dealer_id: target.dealerId,
                            to_dealer_name: target.name,
                            reason,
                            // ID 182: the person's own login (per-person house logins).
                            by_name: user.name ?? null,
                            by_role: user.role,
                            by_house_login: actorIsHouseLogin,
                            via: "bulk_dealer_mobile",
                            ...detachAuditChanges(detachedById.get(leadId)!),
                        },
                        performed_by: user.id,
                        timestamp: now,
                    })),
                );
            }
        });
        for (const [leadId, d] of detachedById) await logPushCouponRelease(d, leadId, user.id, target.name);
        for (const id of movable) {
            if (!pushed.includes(id)) {
                skipped.push({ leadId: id, reason: "This file changed while you were pushing it — reload and try again" });
            }
        }
    }

    // Tell the dealer on WhatsApp, one notice per lead (same as the Step-1
    // push). Best-effort, never throws — the move is already committed.
    if (pushed.length) {
        const { notifyDealerOfPushedLead } = await import("@/lib/whatsapp/pushedLeadNotice");
        for (const id of pushed) {
            await notifyDealerOfPushedLead(id, { reason, fromDealerId: byId.get(id)?.dealerId ?? null });
        }
    }

    return successResponse({
        dealer: { dealerId: target.dealerId, name: target.name },
        pushed,
        skipped,
    });
});
