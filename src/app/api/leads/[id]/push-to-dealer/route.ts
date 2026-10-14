// ID 33: CRM "Push to dealer" for ONE customer file (leads.id — the KYC case
// the admin opens at /admin/kyc-review/[leadId]).
//
//   GET  → may this user push this file now, why not, and the push history.
//   POST { dealer_id | dealer_mobile, reason } → move the file.
//
// Decided 8 + 10 Oct: Admin and Sales Head; first push only from the house
// dealer; one push per file — a second move only by an admin; never after the
// customer signs consent ("Consent is already signed under <dealer>; this file
// can't be moved."); a customer who needs a loan only to a finance-enabled
// dealer. The rules live in checkPush / pushBlockedReason (lib/leads/
// pushToDealer, unit-tested). A push also gives the old dealer's reserved
// coupon back to their pool and clears their salesperson (detachFromOldDealer);
// both are recorded on the push history row.

import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { auditLogs, leads } from "@/lib/db/schema";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";
import { findActiveDealerById, findActiveDealerByMobile, houseDealerCode } from "@/lib/leads/dealerByMobile";
import {
  checkPush,
  needsLoan,
  NO_ACTIVE_DEALER_MESSAGE,
  PUSH_REASON_MAX,
  PUSH_REASON_MIN,
  PUSH_REASON_REQUIRED_MESSAGE,
  PUSH_TO_DEALER_INTERNAL_ROLES,
  pushBlockedReason,
} from "@/lib/leads/pushToDealer";
import {
  dealerDisplayNames,
  detachAuditChanges,
  detachFromOldDealer,
  LEAD_PUSHED_TO_DEALER,
  logPushCouponRelease,
  pushedBeforeLeadIds,
  pushHistory,
  signedConsentLeadIds,
  type DetachResult,
} from "@/lib/leads/pushGuards";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    dealer_id: z.string().trim().min(1).max(50).optional(),
    dealer_mobile: z.string().trim().min(1).max(20).optional(),
    reason: z.string().trim().min(PUSH_REASON_MIN, PUSH_REASON_REQUIRED_MESSAGE).max(PUSH_REASON_MAX),
  })
  .refine((b) => !!b.dealer_id || !!b.dealer_mobile, { message: "Pick a dealer" });

const isCrmPusher = (role: string | null | undefined) =>
  (PUSH_TO_DEALER_INTERNAL_ROLES as readonly string[]).includes(role ?? "");

async function loadFile(leadId: string) {
  const [lead] = await db
    .select({ id: leads.id, dealerId: leads.dealer_id, paymentMethod: leads.payment_method })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  return lead ?? null;
}

export const GET = withErrorHandler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireAuth();
  if (!isCrmPusher(user.role)) return errorResponse("Forbidden", 403);

  const lead = await loadFile((await params).id);
  if (!lead) return errorResponse("Lead not found", 404);
  const house = await houseDealerCode();

  const [signed, pushed, names, history] = await Promise.all([
    signedConsentLeadIds([lead.id]),
    pushedBeforeLeadIds([lead.id]),
    dealerDisplayNames(lead.dealerId ? [lead.dealerId] : []),
    pushHistory(lead.id),
  ]);
  const consentSigned = signed.has(lead.id);
  const pushedBefore = pushed.has(lead.id);
  const isHouse = !!house && lead.dealerId === house;
  const currentDealerName = lead.dealerId ? names.get(lead.dealerId) ?? lead.dealerId : null;

  // Same rules as POST, minus the target-specific ones (finance, same dealer).
  const blockedReason: string | null = !house
    ? "The iTarang house dealer is not set up on this environment."
    : (pushBlockedReason({
        actorRole: user.role,
        currentDealerId: lead.dealerId,
        currentDealerName,
        houseDealerCode: house,
        consentSigned,
        pushedBefore,
      })?.message ?? null);

  return successResponse({
    canPush: blockedReason === null,
    blockedReason,
    isHouse,
    consentSigned,
    pushedBefore,
    needsLoan: needsLoan(lead.paymentMethod),
    currentDealer: lead.dealerId ? { dealerId: lead.dealerId, name: currentDealerName } : null,
    history,
  });
});

export const POST = withErrorHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireAuth();
  if (!isCrmPusher(user.role)) return errorResponse("Only Admin or Sales Head can push a file to a dealer.", 403);

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(parsed.error.issues[0]?.message ?? "Pick a dealer and give a reason.", 400);
  }
  const { dealer_id, dealer_mobile, reason } = parsed.data;

  const house = await houseDealerCode();
  if (!house) return errorResponse("The iTarang house dealer is not set up on this environment.", 500);

  const lead = await loadFile((await params).id);
  if (!lead) return errorResponse("Lead not found", 404);

  // Resolve the dealer: a dealer picked from search wins over a typed mobile.
  let target = dealer_id ? await findActiveDealerById(dealer_id) : null;
  if (!target && !dealer_id && dealer_mobile) {
    const found = await findActiveDealerByMobile(dealer_mobile);
    if (found.status === "found") target = found.dealer;
    else {
      const why =
        found.status === "invalid_mobile"
          ? "Enter a 10-digit dealer mobile number"
          : found.status === "ambiguous"
            ? "More than one active dealer uses this number — ask an admin to fix the dealer records"
            : NO_ACTIVE_DEALER_MESSAGE;
      return errorResponse(why, 422);
    }
  }
  if (!target) return errorResponse("That dealer is not an approved, active dealer.", 422);

  const [signed, pushed, names] = await Promise.all([
    signedConsentLeadIds([lead.id]),
    pushedBeforeLeadIds([lead.id]),
    dealerDisplayNames(lead.dealerId ? [lead.dealerId] : []),
  ]);
  const fromName = lead.dealerId ? names.get(lead.dealerId) ?? lead.dealerId : null;

  const verdict = checkPush({
    actorRole: user.role,
    currentDealerId: lead.dealerId,
    currentDealerName: fromName,
    houseDealerCode: house,
    consentSigned: signed.has(lead.id),
    pushedBefore: pushed.has(lead.id),
    paymentMethod: lead.paymentMethod,
    target,
  });
  if (!verdict.ok) return errorResponse(verdict.message, verdict.status);

  const now = new Date();
  // null = the file moved under us; else what was detached from the old dealer.
  const moved = await db.transaction(async (tx): Promise<DetachResult | null> => {
    // dealer_id = the dealer we checked, so a move someone else made in
    // between is not overwritten.
    const rows = await tx
      .update(leads)
      .set({
        dealer_id: target!.dealerId,
        assignment_status: "assigned",
        dealer_assigned_at: now,
        dealer_assigned_by: user.id,
        // 14 Oct: a delete by the dealer it leaves does not follow the file —
        // the dealer receiving it starts with it on their list.
        deleted_by_dealer_at: null,
        deleted_by_dealer_user: null,
        updated_at: now,
      })
      .where(and(eq(leads.id, lead.id), eq(leads.dealer_id, lead.dealerId!)))
      .returning({ id: leads.id });
    if (!rows.length) return null;

    // ID 33: the old dealer's reserved coupon goes back to their pool and
    // their salesperson comes off the file — the new dealer uses their own.
    const detached = await detachFromOldDealer(tx, lead.id);

    await tx.insert(auditLogs).values({
      id: `AUDIT-${Date.now()}-push`,
      entity_type: "lead",
      entity_id: lead.id,
      action: LEAD_PUSHED_TO_DEALER,
      changes: {
        from_dealer_id: lead.dealerId,
        from_dealer_name: fromName,
        to_dealer_id: target!.dealerId,
        to_dealer_name: target!.name,
        reason,
        by_name: user.name ?? null,
        by_role: user.role,
        via: "crm_push",
        repush: lead.dealerId !== house,
        ...detachAuditChanges(detached),
      },
      performed_by: user.id,
      timestamp: now,
    });
    return detached;
  });
  if (!moved) return errorResponse("This file changed while you were pushing it. Reload and try again.", 409);
  await logPushCouponRelease(moved, lead.id, user.id, target.name);

  // Tell the dealer on WhatsApp. Best-effort, never throws.
  const { notifyDealerOfPushedLead } = await import("@/lib/whatsapp/pushedLeadNotice");
  await notifyDealerOfPushedLead(lead.id);

  return successResponse({ dealer: { dealerId: target.dealerId, name: target.name }, history: await pushHistory(lead.id) });
});
