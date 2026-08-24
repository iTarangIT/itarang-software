/**
 * The Step 3 final decision — approve / reject / dealer-action-required.
 *
 * Lifted verbatim out of `POST /api/admin/kyc/[leadId]/final-decision` (E-246)
 * so that the KYC auto-approval sweep and the admin's button run *the same*
 * code rather than two implementations of the same gate. This mirrors what
 * `closeLotNow()` does for the auction scheduler: one entry point that the
 * manual path and the scheduled path both converge on.
 *
 * The route still owns auth, body parsing and HTTP shaping. Everything that
 * touches the database lives here.
 *
 * BRD §2.9.3 Panel 4 "Step 3 Final Decision Panel" — three actions:
 *   1. approved              → step_3_cleared (unlocks Step 4) or kyc_approved
 *   2. rejected              → kyc_rejected, lead closed
 *   3. dealer_action_required → one of awaiting_additional_docs /
 *      awaiting_co_borrower_kyc / awaiting_co_borrower_replacement /
 *      awaiting_doc_reupload / awaiting_both (computed from card states)
 */

import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import {
    adminVerificationQueue,
    auditLogs,
    coBorrowerRequests,
    coBorrowers,
    couponCodes,
    kycVerifications,
    leads,
    kycVerificationMetadata,
    otherDocumentRequests,
} from "@/lib/db/schema";
import { ADMIN_KYC_OPEN_STATUSES, createWorkflowId } from "@/lib/kyc/admin-workflow";
import {
    notifyKycFinalDecision,
    notifyStep3DealerActionRequired,
} from "@/lib/notifications";

export const VALID_DECISIONS = [
    "approved",
    "rejected",
    "dealer_action_required",
] as const;

export type KycDecision = (typeof VALID_DECISIONS)[number];

/**
 * Only verification types that have a corresponding admin review card in
 * /admin/kyc-review can gate Step 3 approval. System-level rows
 * (esign_consent, esign_consent_sync, address, mobile, photo, etc.) track
 * upstream/customer flows and have no Accept/Reject UI for the admin to act
 * on, so they must not block the final decision.
 *
 * Exported so the E-246 auto-approval sweep accepts exactly the set this gate
 * checks — if the two lists drifted, the sweep would approve cards the gate
 * ignores while leaving cards it blocks on untouched, and every auto-approval
 * would come back `blocked`.
 *
 * NOTE `src/components/kyc/CaseReview.tsx` carries a client-side mirror of this
 * list (`verifTypes`) to disable the Approve button; it is deliberately left as
 * its own copy rather than importing a server module into the bundle.
 */
export const ADMIN_CARD_VERIFICATION_TYPES = [
    "aadhaar",
    "pan",
    "bank",
    "cibil",
    "rc",
] as const;

export function isAdminCardType(t: string | null | undefined): boolean {
    return !!t && (ADMIN_CARD_VERIFICATION_TYPES as readonly string[]).includes(t);
}

/**
 * Who is making the decision. `id` is NULL for the SLA sweep — every actor
 * column on this path is nullable — and `source` is what actually distinguishes
 * a system decision from a human one downstream (see E-246).
 */
export type KycDecisionActor = {
    id: string | null;
    source: "admin" | "system";
};

export type KycFinalDecisionResult =
    | {
          ok: true;
          leadStatus: string;
          couponConsumed: boolean;
          couponCode: string | null;
      }
    | { ok: false; blockers: string[] };

export async function applyKycFinalDecision(input: {
    leadId: string;
    decision: KycDecision;
    notes?: string | null;
    rejectionReason?: string | null;
    actor: KycDecisionActor;
}): Promise<KycFinalDecisionResult> {
    const { leadId, decision, actor } = input;
    const notes = input.notes ?? null;
    const rejectionReason = input.rejectionReason ?? null;

    // Rejection does not require a reason or that every card be individually
    // rejected first — admin can close junk leads in a single click. Approve
    // gating below stays intact.

    // For approved / dealer_action_required we also need the Step 3 state so
    // we can gate the Approve button and compute the correct awaiting status.
    const [step3SupportingDocs, step3CoBorrower, step3Verifications] =
        await Promise.all([
            db
                .select()
                .from(otherDocumentRequests)
                .where(eq(otherDocumentRequests.lead_id, leadId)),
            db
                .select()
                .from(coBorrowers)
                .where(eq(coBorrowers.lead_id, leadId))
                .limit(1),
            db
                .select()
                .from(kycVerifications)
                .where(eq(kycVerifications.lead_id, leadId)),
        ]);

    const hasOpenSupportingDoc = step3SupportingDocs.some(
        (d) => d.upload_status !== "verified",
    );
    const hasRejectedSupportingDoc = step3SupportingDocs.some(
        (d) => d.upload_status === "rejected",
    );
    const hasCoBorrower = !!step3CoBorrower[0];
    const coBorrowerCibilVer = step3Verifications.find(
        (v) => v.applicant === "co_borrower" && v.verification_type === "cibil",
    );
    const coBorrowerIdentityVer = step3Verifications.find(
        (v) =>
            v.applicant === "co_borrower" &&
            (v.verification_type === "aadhaar" || v.verification_type === "pan"),
    );
    const coBorrowerRejectedByIdentity =
        coBorrowerCibilVer?.admin_action === "rejected" ||
        coBorrowerIdentityVer?.admin_action === "rejected";
    const coBorrowerAllApproved =
        hasCoBorrower &&
        step3Verifications
            .filter(
                (v) =>
                    v.applicant === "co_borrower" &&
                    isAdminCardType(v.verification_type),
            )
            .every((v) => v.admin_action === "accepted");

    if (decision === "approved") {
        const blockers: string[] = [];

        for (const v of step3Verifications) {
            const applicant = v.applicant ?? "primary";
            if (applicant !== "primary") continue;
            if (!isAdminCardType(v.verification_type)) continue;
            if (v.admin_action !== "accepted") {
                blockers.push(
                    `${v.verification_type} verification is "${v.admin_action ?? "pending"}" — accept it on the card`,
                );
            }
        }

        for (const d of step3SupportingDocs) {
            // Optional supporting docs (is_required=false) never block approval —
            // an admin can reject an optional doc and still approve the lead.
            if (d.is_required === false) continue;
            if (d.upload_status !== "verified") {
                blockers.push(
                    `Supporting doc "${d.doc_label}" is "${d.upload_status}" — verify or close the request`,
                );
            }
        }

        if (hasCoBorrower && !coBorrowerAllApproved) {
            const cbVers = step3Verifications.filter(
                (v) =>
                    v.applicant === "co_borrower" &&
                    isAdminCardType(v.verification_type),
            );
            if (cbVers.length === 0) {
                blockers.push(
                    "Co-borrower record exists but no co-borrower verifications have been run — either complete co-borrower KYC or remove the co-borrower record",
                );
            } else {
                for (const v of cbVers) {
                    if (v.admin_action !== "accepted") {
                        blockers.push(
                            `Co-borrower ${v.verification_type} is "${v.admin_action ?? "pending"}" — accept it`,
                        );
                    }
                }
            }
        }

        if (blockers.length > 0) {
            return { ok: false, blockers };
        }
    }

    // Find open queue entry
    const queueRows = await db
        .select()
        .from(adminVerificationQueue)
        .where(
            and(
                eq(adminVerificationQueue.lead_id, leadId),
                inArray(
                    adminVerificationQueue.status,
                    ADMIN_KYC_OPEN_STATUSES as unknown as string[],
                ),
            ),
        )
        .limit(1);

    let queueEntry = queueRows[0];

    // Auto-create queue entry if the decision is being made without a formal
    // dealer submission.
    if (!queueEntry) {
        const queueNow = new Date();
        const newId = createWorkflowId("ADMQ", queueNow);
        const inserted = await db
            .insert(adminVerificationQueue)
            .values({
                id: newId,
                queue_type: "kyc_verification",
                lead_id: leadId,
                priority: "normal",
                assigned_to: actor.id,
                submitted_by: actor.id,
                status: "in_progress",
                submitted_at: queueNow,
                created_at: queueNow,
                updated_at: queueNow,
            })
            .returning();
        queueEntry = inserted[0];
    }

    // Fetch metadata to get coupon code
    const metadataRows = await db
        .select()
        .from(kycVerificationMetadata)
        .where(eq(kycVerificationMetadata.lead_id, leadId))
        .limit(1);

    let metadata = metadataRows[0];
    const now = new Date();
    let couponConsumed = false;

    // Auto-create metadata if it doesn't exist
    if (!metadata) {
        const inserted = await db
            .insert(kycVerificationMetadata)
            .values({
                lead_id: leadId,
                submission_timestamp: now,
                created_at: now,
                updated_at: now,
            })
            .returning();
        metadata = inserted[0];
    }

    // Compute the kyc_status to write on the leads row for each decision.
    // For Step 3 "Dealer Action Required" the exact awaiting_* code is
    // derived from which cards are in a rejected / request-docs state
    // (BRD line 2408).
    let leadStatus: string;
    if (decision === "approved") {
        // Step 3 path vs primary path — if there are any supporting docs or a
        // co-borrower row, this is a Step 3 approval and we write step_3_cleared
        // so Step 4 unlocks. Otherwise fall back to kyc_approved for the
        // primary-only path.
        leadStatus =
            hasCoBorrower || step3SupportingDocs.length > 0
                ? "step_3_cleared"
                : "kyc_approved";
    } else if (decision === "rejected") {
        leadStatus = "kyc_rejected";
    } else {
        // dealer_action_required — compute routing
        const supportingIssue = hasRejectedSupportingDoc || hasOpenSupportingDoc;
        const coBorrowerNeedsReplacement =
            hasCoBorrower && coBorrowerRejectedByIdentity;
        const coBorrowerNeedsRework =
            hasCoBorrower && !coBorrowerAllApproved && !coBorrowerRejectedByIdentity;

        if (
            supportingIssue &&
            (coBorrowerNeedsRework || coBorrowerNeedsReplacement)
        ) {
            leadStatus = "awaiting_both";
        } else if (coBorrowerNeedsReplacement) {
            leadStatus = "awaiting_co_borrower_replacement";
        } else if (coBorrowerNeedsRework) {
            leadStatus = "awaiting_co_borrower_kyc";
        } else if (hasRejectedSupportingDoc) {
            leadStatus = "awaiting_doc_reupload";
        } else if (supportingIssue) {
            leadStatus = "awaiting_additional_docs";
        } else {
            leadStatus = "awaiting_additional_docs";
        }
    }

    await db.transaction(async (tx) => {
        // 1. Update queue entry. BRD maps approved→step_3_cleared/kyc_approved
        // onto the queue's terminal "approved" status.
        const queueStatus =
            decision === "approved"
                ? "approved"
                : decision === "rejected"
                  ? "rejected"
                  : "requested_correction";

        await tx
            .update(adminVerificationQueue)
            .set({
                status: queueStatus,
                reviewed_at: now,
                updated_at: now,
            })
            .where(eq(adminVerificationQueue.id, queueEntry.id));

        // 2. Update metadata. dealer_edits_locked stays true for final approve
        // (so dealer can't mutate the case once Step 4 starts) and gets toggled
        // off for dealer_action_required / rejected so the dealer can edit.
        await tx
            .update(kycVerificationMetadata)
            .set({
                final_decision: decision,
                final_decision_at: now,
                final_decision_by: actor.id,
                final_decision_source: actor.source,
                final_decision_notes: notes || rejectionReason,
                dealer_edits_locked: decision === "approved",
                updated_at: now,
            })
            .where(eq(kycVerificationMetadata.lead_id, leadId));

        // 3. If approved, consume coupon
        if (decision === "approved" && metadata?.coupon_code) {
            await tx
                .update(couponCodes)
                .set({
                    status: "used",
                    used_at: now,
                })
                .where(eq(couponCodes.code, metadata.coupon_code));

            await tx
                .update(kycVerificationMetadata)
                .set({ coupon_status: "used", updated_at: now })
                .where(eq(kycVerificationMetadata.lead_id, leadId));

            couponConsumed = true;
        }

        // 4. Co-borrower replacement: increment attempt_number on an open
        // co_borrower_requests row when admin uses Dealer Action Required and
        // the co-borrower's identity/CIBIL was rejected (BRD line 2693).
        if (
            decision === "dealer_action_required" &&
            leadStatus === "awaiting_co_borrower_replacement"
        ) {
            const open = await tx
                .select()
                .from(coBorrowerRequests)
                .where(
                    and(
                        eq(coBorrowerRequests.lead_id, leadId),
                        eq(coBorrowerRequests.status, "open"),
                    ),
                )
                .orderBy(desc(coBorrowerRequests.attempt_number))
                .limit(1);
            if (open[0]) {
                await tx
                    .update(coBorrowerRequests)
                    .set({
                        attempt_number: open[0].attempt_number + 1,
                        reason: rejectionReason || open[0].reason,
                        updated_at: now,
                    })
                    .where(eq(coBorrowerRequests.id, open[0].id));
            }
        }

        // 5. Update lead status
        await tx
            .update(leads)
            .set({ kyc_status: leadStatus, updated_at: now })
            .where(eq(leads.id, leadId));

        // 6. Audit log
        await tx.insert(auditLogs).values({
            id: createWorkflowId("AUDIT", now),
            entity_type: "kyc_final_decision",
            entity_id: leadId,
            action: decision,
            changes: {
                queue_id: queueEntry.id,
                previous_status: queueEntry.status,
                decision,
                lead_status: leadStatus,
                notes,
                rejection_reason: rejectionReason,
                coupon_consumed: couponConsumed,
                coupon_code: metadata?.coupon_code,
                has_co_borrower: hasCoBorrower,
                supporting_docs: step3SupportingDocs.length,
                decided_by: actor.source,
            },
            performed_by: actor.id,
            timestamp: now,
        });
    });

    // Notify dealer on every terminal decision. The dashboard push helpers
    // each map to a specific notification type so the dealer UI can render
    // the correct banner (step_3_cleared vs kyc_approved_final vs action-required).
    if (decision === "approved" || decision === "rejected") {
        notifyKycFinalDecision({
            leadId,
            decision,
            notes,
            rejectionReason,
            adminId: actor.id,
            leadStatus,
        }).catch(() => {});
    } else if (decision === "dealer_action_required") {
        notifyStep3DealerActionRequired({
            leadId,
            leadStatus,
            notes,
            rejectionReason,
        }).catch(() => {});
    }

    // E-264 Phase 2 — the approval that unlocks Section G is invisible to a lead
    // that lives in WhatsApp: the dealer portal lights up, the customer is told
    // nothing, and the lead sits at step_3_cleared until somebody opens it.
    // Offer the choice on the channel they are already on.
    //
    // Best-effort and deliberately un-awaited-for-failure: the decision above is
    // committed, and a WhatsApp outage must never turn an approval into an
    // error. pushStep4ToWhatsApp re-checks payment_method and kyc_status itself,
    // so firing it on every approval is safe — cash leads and primary-only
    // approvals are a no-op inside it.
    if (decision === "approved") {
        // E-264 — policy rules that require a co-borrower regardless of the
        // reviewer's judgement: applicant under 18, over 55, or female.
        //
        // Evaluated HERE rather than at document capture on purpose. The inputs
        // (DOB, and gender from the Aadhaar extraction) are known earlier, but
        // asking a customer to produce a co-borrower for a lead that is about to
        // be rejected wastes their time and ours. At the approval it is a real
        // decision: either the file clears to Step 4, or it needs a co-borrower
        // first — which is exactly the choice this reviewer was making anyway.
        //
        // When a rule fires we request the co-borrower INSTEAD of pushing Step 4;
        // requestCoBorrowerForLead moves the lead back to awaiting_co_borrower_kyc
        // and (via its own hook) asks the customer on WhatsApp. Step 4 fires on
        // the next approval, once the co-borrower has been reviewed.
        void (async () => {
            try {
                const { evaluateAutoCoBorrower } = await import(
                    "@/lib/kyc/coborrower-auto-rules"
                );
                const verdict = await evaluateAutoCoBorrower(leadId);
                if (verdict.required && verdict.reason) {
                    const { requestCoBorrowerForLead } = await import(
                        "@/lib/kyc/coborrower-request"
                    );
                    await requestCoBorrowerForLead(leadId, {
                        reason: verdict.reason,
                        adminUserId: actor.id ?? null,
                    });
                    console.log(
                        `[final-decision] auto co-borrower for ${leadId}: ${verdict.rules.join("; ")}`,
                    );
                    return;
                }

                const { pushStep4ToWhatsApp } = await import(
                    "@/lib/whatsapp/step4-flow"
                );
                await pushStep4ToWhatsApp(leadId);
            } catch (err) {
                console.error(
                    `[final-decision] post-approval WhatsApp step for ${leadId} failed:`,
                    err,
                );
            }
        })();
    }

    return {
        ok: true,
        leadStatus,
        couponConsumed,
        couponCode: metadata?.coupon_code || null,
    };
}

/** The user-facing message for a successful decision, as the route reports it. */
export function messageForDecision(
    decision: KycDecision,
    leadStatus: string,
): string {
    const messages: Record<KycDecision, string> = {
        approved:
            leadStatus === "step_3_cleared"
                ? "Step 3 cleared — Product Selection unlocked."
                : "KYC verification approved successfully.",
        rejected: "KYC verification rejected.",
        dealer_action_required: `Saved. Dealer must action items (${leadStatus.replace(/_/g, " ")}).`,
    };
    return messages[decision];
}
