/**
 * E-390 — Battery Pool diagram 1: the dealer-assignment check.
 * 20 Nov: decided by the iTarang House dealer login (any house login), not the
 * iTarang Admin. Admin / Sales Head only see the queue; the file reaches their
 * KYC review queue once the house approves or changes the dealer.
 * DB side; the pure rules live in ./dealer-assignment-rules.ts.
 *
 *   eligibleDealersForStaff — the dealers an iTarang sales person owns
 *                             (account_ownership, E-321), active + pushable.
 *   staffUserForInitiator   — which sales person is behind a WhatsApp operator
 *                             (whatsapp_operators.user_id) or an iTarang House
 *                             team login (house_login_staff_links).
 *   openDealerReview        — hold the file ('pending_verification') + check row + house bell.
 *   decideDealerReview      — house Approve / Change dealer / Reject (reason).
 *   resubmitDealer          — the initiator re-picks after a rejection.
 *   assertNbfcRoutingAllowed— the Step 4 send-to-lender gate.
 *
 * Notifications are best-effort and never fail the business action.
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  accountOwnership,
  adminVerificationQueue,
  auditLogs,
  houseLoginStaffLinks,
  leadDealerReviews,
  leads,
  users,
  whatsappOnboardingSessions,
  whatsappOperators,
} from "@/lib/db/schema";
import { emit, toAdmins } from "@/lib/notifications/emit";
import { ADMIN_PARTY } from "@/lib/notifications/provenance";

import { findActiveDealerById, houseDealerCode, type PushTargetDealer } from "./dealerByMobile";
import {
  DEALER_CHECK_PENDING,
  DEALER_CHECK_REJECTED,
  dealerCheckKindLabel,
  isNbfcRoutingBlocked,
  validateDealerDecision,
  type DealerCheckKind,
  type DealerDecision,
} from "./dealer-assignment-rules";
import { isHouseLogin, needsLoan, pickerDealers } from "./pushToDealer";
import {
  detachAuditChanges,
  detachFromOldDealer,
  dealerDisplayNames,
  LEAD_PUSHED_TO_DEALER,
  logPushCouponRelease,
} from "./pushGuards";

export * from "./dealer-assignment-rules";

/** Where the house decides (house dealer logins). */
export const DEALER_CHECKS_HREF = "/dealer-portal/dealer-checks";
/** Admin / Sales Head's view-only copy of the queue. */
export const ADMIN_DEALER_CHECKS_HREF = "/admin/dealer-checks";

/** May this login SEE the dealer checks from the dealer portal? Any iTarang house login. */
export async function mayViewHouseDealerChecks(user: {
  role: string | null | undefined;
  dealer_id?: string | null;
}): Promise<boolean> {
  return isHouseLogin({ role: user.role, dealerId: user.dealer_id ?? null, houseDealerCode: await houseDealerCode() });
}

/**
 * May this login DECIDE dealer checks?
 *  - the main iTarang House login (dealer@itarang.com / WHATSAPP_HOUSE_DEALER_EMAIL);
 *  - 23 Nov: a house team login marked "Can approve" (Admin › House team logins);
 *  - 23 Nov: a person on Settings › Dealer check alerts (Chirag, Anirudh, Admin,
 *    Sanchit …) — they get the email / WhatsApp link and may also act on the CRM.
 * Other house team logins see the queue only. Every decision records the
 * person's own user id and name.
 */
export async function mayDecideDealerChecks(user: {
  id: string;
  role: string | null | undefined;
  dealer_id?: string | null;
}): Promise<boolean> {
  try {
    const { getDealerCheckSettings } = await import("./dealer-check-settings");
    const settings = await getDealerCheckSettings();
    if (settings.recipients.some((r) => r.userId === user.id)) return true;
    if (user.role !== "dealer") return false;
    const { resolveHouseDealer } = await import("@/lib/whatsapp/customer-lead");
    const house = await resolveHouseDealer();
    if (!house || user.dealer_id !== house.dealerCode) return false;
    return house.uploaderId === user.id || settings.houseApproverIds.includes(user.id);
  } catch (err) {
    console.warn("[dealer-assignment] house login lookup failed", err instanceof Error ? err.message : String(err));
    return false;
  }
}

export type Candidate = { dealerId: string; name: string };

export interface DealerCheckInitiator {
  userId: string | null;
  name: string | null;
  /** E.164 without '+' — set for a WhatsApp initiator (operator / dealer salesperson). */
  waPhone?: string | null;
}

// ── Who is the sales person, and which dealers does he own ────────────────────

/**
 * The iTarang sales person behind a WhatsApp operator number or an iTarang
 * House team login. Null when the admin has not linked one.
 */
export async function staffUserForInitiator(opts: {
  operatorUserId?: string | null;
  loginUserId?: string | null;
}): Promise<string | null> {
  if (opts.operatorUserId) return opts.operatorUserId;
  if (!opts.loginUserId) return null;
  try {
    const [l] = await db
      .select({ staff: houseLoginStaffLinks.staff_user_id })
      .from(houseLoginStaffLinks)
      .where(eq(houseLoginStaffLinks.login_user_id, opts.loginUserId))
      .limit(1);
    return l?.staff ?? null;
  } catch (err) {
    // A database without E-390 behaves as "not linked".
    console.warn("[dealer-assignment] staff link lookup failed", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Active, new-battery, not-closed dealers the sales person owns, by name. A
 * customer who needs a loan only sees finance-enabled dealers.
 */
export async function eligibleDealersForStaff(
  staffUserId: string | null | undefined,
  opts: { financeOnly?: boolean } = {},
): Promise<PushTargetDealer[]> {
  if (!staffUserId) return [];
  const owned = await db
    .select({ accountId: accountOwnership.account_id })
    .from(accountOwnership)
    .where(eq(accountOwnership.owner_user_id, staffUserId));
  const house = await houseDealerCode();
  const out: PushTargetDealer[] = [];
  for (const o of owned) {
    if (!o.accountId || o.accountId === house) continue;
    const d = await findActiveDealerById(o.accountId);
    if (d) out.push(d);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return pickerDealers(out, opts);
}

// ── Open a check ─────────────────────────────────────────────────────────────

/**
 * Hold the file for the iTarang House dealer check: assignment_status =
 * 'pending_verification', one pending lead_dealer_reviews row (any older
 * pending row for the lead is closed first), house bell. Never throws — a
 * database without E-390 leaves the lead exactly as it was.
 */
export async function openDealerReview(opts: {
  leadId: string;
  dealerId: string;
  reasonKind: DealerCheckKind;
  candidates?: Candidate[];
  channel: "web" | "whatsapp";
  initiator: DealerCheckInitiator;
}): Promise<{ id: string } | null> {
  try {
    const now = new Date();
    const id = await db.transaction(async (tx) => {
      // A re-push / re-pick replaces any check still open on this lead.
      await tx
        .update(leadDealerReviews)
        .set({ status: "changed", decision_reason: "Superseded by a newer dealer assignment", decided_at: now, updated_at: now })
        .where(and(eq(leadDealerReviews.lead_id, opts.leadId), eq(leadDealerReviews.status, "pending")));
      const [row] = await tx
        .insert(leadDealerReviews)
        .values({
          lead_id: opts.leadId,
          dealer_id: opts.dealerId,
          reason_kind: opts.reasonKind,
          candidates: (opts.candidates ?? []).slice(0, 50),
          channel: opts.channel,
          initiated_by_user_id: opts.initiator.userId,
          initiated_by_name: opts.initiator.name,
          initiator_wa_phone: opts.initiator.waPhone ?? null,
          status: "pending",
          created_at: now,
          updated_at: now,
        })
        .returning({ id: leadDealerReviews.id });
      await tx
        .update(leads)
        .set({ assignment_status: DEALER_CHECK_PENDING, updated_at: now })
        .where(eq(leads.id, opts.leadId));
      return row.id;
    });

    void notifyHouseOfDealerCheck(opts.leadId, opts.dealerId, opts.reasonKind, opts.initiator.name);
    // 23 Nov (point 4): email + WhatsApp with an act-on-it link to the alert list.
    void (async () => {
      const { noticeDealerCheckOpened } = await import("./dealer-check-notify");
      const names = await dealerDisplayNames([opts.dealerId]);
      await noticeDealerCheckOpened({
        reviewId: id,
        leadId: opts.leadId,
        dealerName: names.get(opts.dealerId) ?? opts.dealerId,
        reasonLabel: dealerCheckKindLabel(opts.reasonKind),
        initiatorName: opts.initiator.name,
      });
    })().catch((err) => console.warn("[dealer-assignment] alert notice failed", err));
    return { id };
  } catch (err) {
    console.error("[dealer-assignment] openDealerReview failed", err);
    return null;
  }
}

async function leadLabel(leadId: string): Promise<{ name: string; ref: string }> {
  const [l] = await db
    .select({ full_name: leads.full_name, owner_name: leads.owner_name, reference_id: leads.reference_id })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  return { name: l?.full_name || l?.owner_name || leadId, ref: l?.reference_id || leadId };
}

async function notifyHouseOfDealerCheck(leadId: string, dealerId: string, kind: string, by: string | null) {
  try {
    // The main house login and the house logins marked "Can approve" get the bell.
    const { resolveHouseDealer } = await import("@/lib/whatsapp/customer-lead");
    const house = await resolveHouseDealer();
    if (!house) return;
    const { getDealerCheckSettings } = await import("./dealer-check-settings");
    const approvers = (await getDealerCheckSettings()).houseApproverIds.filter((id) => id !== house.uploaderId);
    const [{ name, ref }, names] = await Promise.all([leadLabel(leadId), dealerDisplayNames([dealerId])]);
    await emit({
      type: "lead.dealer_check_pending",
      title: "Dealer assignment to check",
      message: `${name} (${ref}) is tagged to ${names.get(dealerId) ?? dealerId}. ${dealerCheckKindLabel(kind)}${
        by ? ` — ${by}` : ""
      }. Approve, change or reject the dealer — the file goes to the iTarang KYC review after that.`,
      leadId,
      stage: "Dealer assignment",
      to: [house.uploaderId, ...approvers].map((userId) => ({
        audience: { kind: "user" as const, userId },
        as: ADMIN_PARTY,
        href: DEALER_CHECKS_HREF,
      })),
    });
  } catch (err) {
    console.warn("[dealer-assignment] house notice failed", err instanceof Error ? err.message : String(err));
  }
}

/**
 * After the house approves / changes the dealer: if the dealer already
 * submitted KYC (an admin_verification_queue row), tell Admin / Sales Head the
 * file is now on their KYC review queue (the submit-time bell was held back).
 */
async function notifyAdminsKycReady(leadId: string, dealerName: string) {
  try {
    // Only a case still open for review (not one already decided).
    const [q] = await db
      .select({ id: adminVerificationQueue.id })
      .from(adminVerificationQueue)
      .where(
        and(
          eq(adminVerificationQueue.lead_id, leadId),
          eq(adminVerificationQueue.status, "pending_itarang_verification"),
        ),
      )
      .limit(1);
    if (!q) return;
    const { name, ref } = await leadLabel(leadId);
    await emit({
      type: "kyc.submitted",
      title: "KYC ready for review",
      message: `iTarang House confirmed ${dealerName} for ${name} (${ref}). The KYC is now waiting for your review.`,
      leadId,
      stage: "Step 2 · KYC",
      to: [toAdmins({ href: `/admin/kyc-review/${encodeURIComponent(leadId)}` })],
    });
  } catch (err) {
    console.warn("[dealer-assignment] KYC-ready notice failed", err instanceof Error ? err.message : String(err));
  }
}

// ── Gate ─────────────────────────────────────────────────────────────────────

/** Throws Error(<dealer-readable message>) when the lead may not go to a lender yet. */
export async function assertNbfcRoutingAllowed(leadId: string): Promise<void> {
  const [l] = await db
    .select({ s: leads.assignment_status })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  const b = isNbfcRoutingBlocked(l?.s);
  if (b.blocked) throw new Error(b.message);
}

/** Soft check for UI / WhatsApp copy. */
export async function nbfcRoutingBlock(leadId: string): Promise<string | null> {
  const [l] = await db
    .select({ s: leads.assignment_status })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  const b = isNbfcRoutingBlocked(l?.s);
  return b.blocked ? b.message : null;
}

// ── Read ─────────────────────────────────────────────────────────────────────

export async function latestDealerReview(leadId: string) {
  try {
    const [r] = await db
      .select()
      .from(leadDealerReviews)
      .where(eq(leadDealerReviews.lead_id, leadId))
      .orderBy(desc(leadDealerReviews.created_at))
      .limit(1);
    return r ?? null;
  } catch {
    return null;
  }
}

export async function listDealerReviews(view: "pending" | "decided", limit = 200) {
  const rows = await db
    .select({
      id: leadDealerReviews.id,
      lead_id: leadDealerReviews.lead_id,
      dealer_id: leadDealerReviews.dealer_id,
      reason_kind: leadDealerReviews.reason_kind,
      candidates: leadDealerReviews.candidates,
      channel: leadDealerReviews.channel,
      initiated_by_name: leadDealerReviews.initiated_by_name,
      status: leadDealerReviews.status,
      decided_by: leadDealerReviews.decided_by,
      decided_at: leadDealerReviews.decided_at,
      decision_reason: leadDealerReviews.decision_reason,
      final_dealer_id: leadDealerReviews.final_dealer_id,
      created_at: leadDealerReviews.created_at,
      customer: leads.full_name,
      owner_name: leads.owner_name,
      reference_id: leads.reference_id,
      city: leads.city,
      state: leads.state,
      kyc_status: leads.kyc_status,
      payment_method: leads.payment_method,
    })
    .from(leadDealerReviews)
    .leftJoin(leads, eq(leads.id, leadDealerReviews.lead_id))
    .where(
      view === "pending"
        ? eq(leadDealerReviews.status, "pending")
        : inArray(leadDealerReviews.status, ["approved", "changed", "rejected"]),
    )
    .orderBy(desc(leadDealerReviews.created_at))
    .limit(limit);

  const codes = rows.flatMap((r) => [r.dealer_id, r.final_dealer_id ?? ""]).filter(Boolean);
  const [names, deciders] = await Promise.all([
    dealerDisplayNames(codes),
    (async () => {
      const ids = [...new Set(rows.map((r) => r.decided_by).filter((x): x is string => !!x))];
      if (!ids.length) return new Map<string, string>();
      const us = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids));
      return new Map(us.map((u) => [u.id, u.name || u.email || "—"]));
    })(),
  ]);
  return rows.map((r) => ({
    ...r,
    customer: r.customer || r.owner_name || null,
    dealer_name: names.get(r.dealer_id) ?? r.dealer_id,
    final_dealer_name: r.final_dealer_id ? names.get(r.final_dealer_id) ?? r.final_dealer_id : null,
    reason_label: dealerCheckKindLabel(r.reason_kind),
    decided_by_name: r.decided_by ? deciders.get(r.decided_by) ?? null : null,
  }));
}

// ── Decide ───────────────────────────────────────────────────────────────────

export class DealerCheckError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * iTarang House decision on a pending dealer check.
 *  approve → 'assigned'.
 *  change  → the file moves to the dealer the house picked (coupon / salesperson
 *            detached like a push, LEAD_PUSHED_TO_DEALER audit), then 'assigned'.
 *            Allowed even after consent: it is iTarang's own correction and is
 *            recorded on the push history.
 *  reject  → 'dealer_rejected'; the initiator is told and re-picks.
 * Approve / change on a KYC-cleared finance lead re-sends WhatsApp "Choose lender".
 */
export async function decideDealerReview(opts: {
  reviewId: string;
  actor: { id: string; name: string | null; role: string | null; via?: "crm" | "link" };
  decision: DealerDecision;
  newDealerId?: string | null;
  reason?: string | null;
}) {
  const [review] = await db.select().from(leadDealerReviews).where(eq(leadDealerReviews.id, opts.reviewId)).limit(1);
  if (!review) throw new DealerCheckError("Dealer check not found", 404);
  if (review.status !== "pending") throw new DealerCheckError("This dealer check was already decided — refresh the page.", 409);

  const [lead] = await db
    .select({ id: leads.id, dealerId: leads.dealer_id, paymentMethod: leads.payment_method })
    .from(leads)
    .where(eq(leads.id, review.lead_id))
    .limit(1);
  if (!lead) throw new DealerCheckError("Lead not found", 404);
  const currentDealerId = lead.dealerId ?? review.dealer_id;

  const v = validateDealerDecision({
    decision: opts.decision,
    newDealerId: opts.newDealerId,
    currentDealerId,
    reason: opts.reason,
  });
  if (!v.ok) throw new DealerCheckError(v.message, 400);

  const reason = opts.reason?.trim().slice(0, 1000) || null;
  const now = new Date();

  let target: PushTargetDealer | null = null;
  if (opts.decision === "change") {
    target = await findActiveDealerById(opts.newDealerId);
    if (!target) throw new DealerCheckError("That dealer is not an approved, active dealer.", 422);
    if (needsLoan(lead.paymentMethod) && !target.financeEnabled) {
      throw new DealerCheckError(`${target.name} is not enabled for finance leads.`, 422);
    }
  }

  const status = opts.decision === "approve" ? "approved" : opts.decision === "change" ? "changed" : "rejected";
  const names = await dealerDisplayNames([currentDealerId]);
  const fromName = names.get(currentDealerId) ?? currentDealerId;

  const detached = await db.transaction(async (tx) => {
    const updated = await tx
      .update(leadDealerReviews)
      .set({
        status,
        decided_by: opts.actor.id,
        decided_at: now,
        decision_reason: reason,
        final_dealer_id: opts.decision === "reject" ? null : target?.dealerId ?? currentDealerId,
        updated_at: now,
      })
      .where(and(eq(leadDealerReviews.id, review.id), eq(leadDealerReviews.status, "pending")))
      .returning({ id: leadDealerReviews.id });
    if (!updated.length) throw new DealerCheckError("This dealer check was already decided — refresh the page.", 409);

    if (opts.decision === "reject") {
      await tx.update(leads).set({ assignment_status: DEALER_CHECK_REJECTED, updated_at: now }).where(eq(leads.id, lead.id));
      return null;
    }
    if (opts.decision === "approve") {
      await tx.update(leads).set({ assignment_status: "assigned", updated_at: now }).where(eq(leads.id, lead.id));
      return null;
    }
    // change
    await tx
      .update(leads)
      .set({
        dealer_id: target!.dealerId,
        assignment_status: "assigned",
        dealer_assigned_at: now,
        dealer_assigned_by: opts.actor.id,
        deleted_by_dealer_at: null,
        deleted_by_dealer_user: null,
        updated_at: now,
      })
      .where(eq(leads.id, lead.id));
    const d = await detachFromOldDealer(tx, lead.id);
    await tx.insert(auditLogs).values({
      id: `AUDIT-${Date.now()}-dcheck`,
      entity_type: "lead",
      entity_id: lead.id,
      action: LEAD_PUSHED_TO_DEALER,
      changes: {
        from_dealer_id: currentDealerId,
        from_dealer_name: fromName,
        to_dealer_id: target!.dealerId,
        to_dealer_name: target!.name,
        reason: reason ?? "Corrected in the dealer assignment check",
        by_name: opts.actor.name ?? "iTarang House",
        by_role: opts.actor.role,
        via: "dealer_check",
        repush: true,
        ...detachAuditChanges(d),
      },
      performed_by: opts.actor.id,
      timestamp: now,
    });
    return d;
  });

  if (opts.decision === "change" && detached && target) {
    await logPushCouponRelease(detached, lead.id, opts.actor.id, target.name).catch(() => {});
  }

  // 20 Nov (items 6–7): the dealer hears about the file only now — after
  // iTarang House approved (or changed) the dealer — never at push time.
  if (opts.decision !== "reject") {
    await notifyDealerAfterHouseDecision({
      review,
      leadId: lead.id,
      changed: opts.decision === "change",
      fromDealerId: currentDealerId,
      changeReason: reason,
    });
  }

  void notifyInitiatorOfDecision({
    review,
    decision: opts.decision,
    reason,
    dealerName: target?.name ?? fromName,
    adminName: opts.actor.name,
  });

  if (opts.decision !== "reject") {
    // 20 Nov: the KYC automation clocks were paused while the file was held;
    // give the admin a full window from now (else an elapsed clock would
    // auto-approve the moment the file reached them).
    try {
      const { restartKycClocksAfterDealerCheck } = await import("@/lib/kyc/auto-approval");
      await restartKycClocksAfterDealerCheck(lead.id);
    } catch (err) {
      console.warn("[dealer-assignment] KYC clock restart failed", err instanceof Error ? err.message : String(err));
    }
    void notifyAdminsKycReady(lead.id, target?.name ?? fromName);
    try {
      // E-391 — auto-route by an NBFC routing rule, else "Choose lender".
      const { step4OpenedFor } = await import("./nbfc-routing");
      void step4OpenedFor(lead.id, "dealer_check_approved").catch(() => {});
    } catch {
      /* best-effort */
    }
  }

  // 23 Nov (point 3): the internal audit line — WHO approved / changed /
  // rejected, on the CRM or by the email / WhatsApp link. The KYC timeline on
  // the review page shows the name to iTarang; the dealer sees "iTarang team".
  const { decisionPhrase } = await import("./dealer-check-settings-rules");
  const phrase = decisionPhrase(opts.decision, fromName, target?.name);
  try {
    const { recordKycEvent } = await import("@/lib/kyc/kycEventLog");
    const actorIsHouse = opts.actor.role === "dealer";
    await recordKycEvent({
      leadId: lead.id,
      action: `Dealer check: ${phrase}${reason ? ` — ${reason}` : ""}`,
      actor: {
        id: opts.actor.id,
        name: opts.actor.name,
        role: opts.actor.role,
        type: actorIsHouse ? "house" : "itarang",
        channel: "web",
      },
      detail: {
        dealer_check_id: review.id,
        dealer_check_decision: opts.decision,
        dealer_check_via: opts.actor.via ?? "crm",
        from_dealer_id: currentDealerId,
        to_dealer_id: target?.dealerId ?? null,
      },
      notify: false,
    });
  } catch (err) {
    console.warn("[dealer-assignment] audit line failed", err instanceof Error ? err.message : String(err));
  }

  // 23 Nov (point 4): everyone else on the alert list — "action taken by <name>".
  void (async () => {
    const { noticeDealerCheckDecided } = await import("./dealer-check-notify");
    await noticeDealerCheckDecided({
      leadId: lead.id,
      actorUserId: opts.actor.id,
      actorName: opts.actor.name ?? "iTarang House",
      phrase,
      reason,
    });
  })().catch((err) => console.warn("[dealer-assignment] decided notice failed", err));

  return { id: review.id, status, dealer: target ? { dealerId: target.dealerId, name: target.name } : null };
}

/**
 * 20 Nov (items 6–7) — the dealer's "New customer file from iTarang" notice
 * (bell + email + WhatsApp) is held at push time while the file waits for the
 * iTarang House dealer check, and sent here once the house approves / changes.
 *  - A file the dealer's OWN sales team started (dealer_salesperson) is already
 *    the dealer's: approve sends nothing; a change tells the new dealer and
 *    the old one (who knew about it) that it moved.
 *  - Any iTarang push (sales person / house): the final dealer gets the push
 *    notice with the original push reason. A dealer that was replaced before
 *    approval was never told, so it gets no "moved away" notice.
 * Never throws.
 */
async function notifyDealerAfterHouseDecision(opts: {
  review: typeof leadDealerReviews.$inferSelect;
  leadId: string;
  changed: boolean;
  fromDealerId: string;
  changeReason: string | null;
}) {
  try {
    const ownTeam = opts.review.reason_kind === "dealer_salesperson";
    if (ownTeam && !opts.changed) return;
    const { notifyDealerOfPushedLead } = await import("@/lib/whatsapp/pushedLeadNotice");
    const reason = opts.changed
      ? opts.changeReason ?? "Corrected in the dealer assignment check"
      : await latestPushReason(opts.leadId);
    await notifyDealerOfPushedLead(opts.leadId, {
      reason,
      fromDealerId: ownTeam ? opts.fromDealerId : null,
    });
  } catch (err) {
    console.warn("[dealer-assignment] dealer notice failed", err instanceof Error ? err.message : String(err));
  }
}

/** The reason on the file's latest push audit row (what the pusher typed). */
async function latestPushReason(leadId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ changes: auditLogs.changes })
      .from(auditLogs)
      .where(and(eq(auditLogs.entity_type, "lead"), eq(auditLogs.entity_id, leadId), eq(auditLogs.action, LEAD_PUSHED_TO_DEALER)))
      .orderBy(desc(auditLogs.timestamp))
      .limit(1);
    const r = (row?.changes as { reason?: unknown } | null)?.reason;
    return typeof r === "string" && r.trim() ? r : null;
  } catch {
    return null;
  }
}

/**
 * Push sites call this instead of notifyDealerOfPushedLead directly: when the
 * file went to the iTarang House dealer check, the dealer notice waits for the
 * house decision (notifyDealerAfterHouseDecision). Only when no check could be
 * opened (a database without E-390) is the dealer told straight away.
 */
export async function notifyDealerUnlessHeld(
  leadId: string,
  review: { id: string } | null,
  notice: { reason?: string | null; fromDealerId?: string | null },
): Promise<void> {
  if (review) {
    // The dealer that LOST the file did know about it — tell it now.
    if (notice.fromDealerId) {
      const { notifyDealerOfPushAway } = await import("./pushNotices");
      await notifyDealerOfPushAway(leadId, notice.fromDealerId);
    }
    return;
  }
  const { notifyDealerOfPushedLead } = await import("@/lib/whatsapp/pushedLeadNotice");
  await notifyDealerOfPushedLead(leadId, notice);
}

/** Bell (CRM initiator) + WhatsApp (operator / dealer sales team). Never throws. */
async function notifyInitiatorOfDecision(opts: {
  review: typeof leadDealerReviews.$inferSelect;
  decision: DealerDecision;
  reason: string | null;
  dealerName: string;
  adminName: string | null;
}) {
  const { review, decision, reason, dealerName } = opts;
  try {
    const { name, ref } = await leadLabel(review.lead_id);
    const title =
      decision === "reject"
        ? "Dealer rejected — pick the correct dealer"
        : decision === "change"
          ? "iTarang House changed the dealer"
          : "Paperwork accepted — KYC still under review";
    // 23 Nov (point 5): an approval accepts the paperwork — it is not KYC approval.
    const { PAPERWORK_ACCEPTED_NOTE } = await import("./dealer-check-settings-rules");
    const message =
      decision === "reject"
        ? `iTarang House rejected ${dealerName} for ${name} (${ref}): ${reason}. Pick the correct dealer again.`
        : decision === "change"
          ? `iTarang House moved ${name} (${ref}) to ${dealerName}. ${PAPERWORK_ACCEPTED_NOTE}`
          : `iTarang House confirmed ${dealerName} for ${name} (${ref}). ${PAPERWORK_ACCEPTED_NOTE}`;

    if (review.initiated_by_user_id) {
      await emit({
        type: decision === "reject" ? "lead.dealer_check_rejected" : "lead.dealer_check_approved",
        title,
        message,
        leadId: review.lead_id,
        stage: "Dealer assignment",
        to: [
          {
            audience: { kind: "user", userId: review.initiated_by_user_id },
            as: { party: "admin", label: opts.adminName ?? "iTarang House" },
            href: `/dealer-portal/leads/${encodeURIComponent(review.lead_id)}`,
          },
        ],
      });
    }

    if (review.channel === "whatsapp") {
      await whatsappNoticeToInitiator(review, message, decision === "reject");
    }
  } catch (err) {
    console.warn("[dealer-assignment] initiator notice failed", err instanceof Error ? err.message : String(err));
  }
}

/** Row id an operator taps to re-pick a dealer after a rejection. */
export function dealerFixRowId(reviewId: string, dealerId: string): string {
  return `dcfix:${reviewId}:${dealerId}`;
}

export function parseDealerFixRowId(text: string | null | undefined): { reviewId: string; dealerId: string } | null {
  const m = /^dcfix:([0-9a-f-]{36}):(.+)$/i.exec((text ?? "").trim());
  return m ? { reviewId: m[1], dealerId: m[2] } : null;
}

async function whatsappNoticeToInitiator(
  review: typeof leadDealerReviews.$inferSelect,
  message: string,
  rejected: boolean,
) {
  const { reply, replyList } = await import("@/lib/whatsapp/session-store");

  // An operator: their hub session, with a re-pick list on a rejection.
  if (review.initiator_wa_phone) {
    const [hub] = await db
      .select()
      .from(whatsappOnboardingSessions)
      .where(
        and(
          eq(whatsappOnboardingSessions.wa_phone, review.initiator_wa_phone),
          eq(whatsappOnboardingSessions.session_kind, "operator_hub"),
        ),
      )
      .orderBy(desc(whatsappOnboardingSessions.updated_at))
      .limit(1);
    if (hub) {
      const session = hub as unknown as Parameters<typeof reply>[0];
      if (!rejected) return await reply(session, `✅ ${message}`);
      const [op] = await db
        .select({ userId: whatsappOperators.user_id })
        .from(whatsappOperators)
        .where(eq(whatsappOperators.wa_phone, review.initiator_wa_phone))
        .limit(1);
      const [lead] = await db.select({ pm: leads.payment_method }).from(leads).where(eq(leads.id, review.lead_id)).limit(1);
      const options = (await eligibleDealersForStaff(op?.userId ?? null, { financeOnly: needsLoan(lead?.pm) }))
        .filter((d) => d.dealerId !== review.dealer_id)
        .slice(0, 10);
      if (!options.length) {
        return await reply(session, `❌ ${message}\n\nYou have no other dealer to pick — iTarang House will assign it.`);
      }
      return await replyList(
        session,
        `❌ ${message}`,
        "Pick dealer",
        options.map((d) => ({ id: dealerFixRowId(review.id, d.dealerId), title: d.name.slice(0, 24) })),
      );
    }
  }

  // A dealer sales-team member (or no hub): the lead's own chat.
  const { pushToLead } = await import("@/lib/whatsapp/lead-push");
  await pushToLead(review.lead_id, (t) => ({
    prompt: {
      kind: "text",
      body: `${rejected ? "❌" : "✅"} ${message}${rejected ? "\n\nPlease contact iTarang House with the correct dealer." : ""}`,
    },
    nudge: {
      template: "lead_action",
      params: [
        t.greetName,
        t.referenceId,
        rejected
          ? "the dealer on this application needs correcting"
          : "paperwork accepted for processing — KYC is not approved yet",
      ],
    },
  }));
}

// ── Resubmit after a rejection ───────────────────────────────────────────────

/**
 * The initiator picks the correct dealer after a rejection. The file moves to
 * that dealer (if different) and goes back to iTarang House as a new check.
 */
export async function resubmitDealer(opts: {
  leadId: string;
  dealerId: string;
  initiator: DealerCheckInitiator;
  channel: "web" | "whatsapp";
  /** The rejected review this answers, when known (WhatsApp list row). */
  reviewId?: string | null;
}) {
  const last = await latestDealerReview(opts.leadId);
  if (!last || last.status !== "rejected") {
    throw new DealerCheckError("This application is not waiting for a dealer correction.", 409);
  }
  if (opts.reviewId && last.id !== opts.reviewId) {
    throw new DealerCheckError("This dealer list is out of date — the application changed since.", 409);
  }
  const target = await findActiveDealerById(opts.dealerId);
  if (!target) throw new DealerCheckError("That dealer is not an approved, active dealer.", 422);
  const [lead] = await db
    .select({ dealerId: leads.dealer_id, pm: leads.payment_method })
    .from(leads)
    .where(eq(leads.id, opts.leadId))
    .limit(1);
  if (!lead) throw new DealerCheckError("Lead not found", 404);
  if (needsLoan(lead.pm) && !target.financeEnabled) {
    throw new DealerCheckError(`${target.name} is not enabled for finance leads.`, 422);
  }

  if (lead.dealerId !== target.dealerId) {
    const now = new Date();
    const fromName = (await dealerDisplayNames(lead.dealerId ? [lead.dealerId] : [])).get(lead.dealerId ?? "") ?? lead.dealerId;
    const detached = await db.transaction(async (tx) => {
      await tx
        .update(leads)
        .set({
          dealer_id: target.dealerId,
          dealer_assigned_at: now,
          dealer_assigned_by: opts.initiator.userId,
          deleted_by_dealer_at: null,
          deleted_by_dealer_user: null,
          updated_at: now,
        })
        .where(eq(leads.id, opts.leadId));
      const d = await detachFromOldDealer(tx, opts.leadId);
      await tx.insert(auditLogs).values({
        id: `AUDIT-${Date.now()}-dcfix`,
        entity_type: "lead",
        entity_id: opts.leadId,
        action: LEAD_PUSHED_TO_DEALER,
        changes: {
          from_dealer_id: lead.dealerId,
          from_dealer_name: fromName,
          to_dealer_id: target.dealerId,
          to_dealer_name: target.name,
          reason: "Re-picked after iTarang House rejected the dealer",
          by_name: opts.initiator.name,
          via: "dealer_check_resubmit",
          repush: true,
          ...detachAuditChanges(d),
        },
        performed_by: opts.initiator.userId,
        timestamp: now,
      });
      return d;
    });
    await logPushCouponRelease(detached, opts.leadId, opts.initiator.userId, target.name).catch(() => {});
  }

  const opened = await openDealerReview({
    leadId: opts.leadId,
    dealerId: target.dealerId,
    reasonKind: "resubmit",
    candidates: [],
    channel: opts.channel,
    initiator: opts.initiator,
  });
  if (!opened) throw new DealerCheckError("Could not send the dealer back for checking — try again.", 500);
  return { dealer: { dealerId: target.dealerId, name: target.name } };
}
