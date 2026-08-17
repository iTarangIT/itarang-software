/**
 * KYC auto-approval — the E-246 SLA sweep.
 *
 * WHAT THIS DOES. When a dealer submits documents + coupon, a deadline is
 * stamped on the `admin_verification_queue` row. If that deadline passes with
 * the case still sitting in `pending_itarang_verification`, this module:
 *
 *   1. accepts the still-PENDING verification cards,
 *   2. marks the required supporting-doc requests verified,
 *   3. runs the ordinary final-decision path,
 *
 * which writes `leads.kyc_status = 'step_3_cleared'` and unlocks the dealer's
 * Step 4. Customer consent runs on the same clock (E-247): signing stamps
 * `consent_records.auto_verify_due_at`, and the sweep verifies it once that
 * passes, so the admin gets a window to reject in.
 *
 * EVERYTHING THIS TOUCHES MUST BE ADMITTED BY A STAMPED DEADLINE. Both halves
 * are opt-in per record — a queue row without `sla_due_at`, or a consent without
 * `auto_verify_due_at`, is invisible to the sweep. That is what makes enabling
 * the feature unable to reach backwards over existing work, and it is not
 * decoration: E-246 shipped the consent half without that guard and the first
 * real tick verified 14 consents signed months earlier. Never widen those
 * predicates, and never backfill either column.
 *
 * ⚠ NO PROVIDER CALLS ARE MADE. Step 1 does not run Decentro PAN/bank/bureau or
 * pull Aadhaar from DigiLocker; it flips the admin verdict only and leaves
 * `api_response` exactly as the provider did (or did not) leave it, so the row
 * never claims a check that never happened. `admin_action_source='system'` is
 * what tells every downstream reader that "accepted" here means "nobody
 * objected in time", not "verified".
 *
 * WHAT IT WILL NOT DO. It only ever touches rows with `admin_action IS NULL`.
 * An admin who rejected a card, or asked for more documents, has engaged with
 * the case; that verdict stands, the approve gate in `applyKycFinalDecision`
 * then legitimately refuses, and the case is recorded `blocked` and left for
 * the human. Auto-approval is for silence, not for overriding a decision.
 *
 * THE CLOCK IS THE DATABASE'S, NOT THIS PROCESS'S. Every comparison runs
 * against Postgres `now()`. A ~1s drift between a pm2 VPS and RDS was enough to
 * leave past-deadline auction lots live (see `src/lib/nbfc/auction/scheduler.ts`)
 * and the same trap applies here. `now` is a test override only, and is passed
 * as ISO text cast to timestamptz — a JS `Date` cannot be bound through a
 * drizzle raw `sql` template (postgres-js throws ERR_INVALID_ARG_TYPE).
 */

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
    adminVerificationQueue,
    auditLogs,
    coBorrowers,
    consentRecords,
    kycVerifications,
    leads,
    otherDocumentRequests,
} from "@/lib/db/schema";
import { createWorkflowId } from "@/lib/kyc/admin-workflow";
import {
    ADMIN_CARD_VERIFICATION_TYPES,
    applyKycFinalDecision,
} from "@/lib/kyc/final-decision";
import {
    CARD_SLA_TYPES,
    formatSlaWindow,
    getKycAutoApprovalSettings,
    type CardSlaType,
    type KycAutoApprovalSettings,
} from "@/lib/kyc/auto-approval-settings";
import { notifyKycAutoApproved } from "@/lib/notifications/events";

/**
 * Compile-time guard (E-248): the settings screen offers a per-card window for
 * exactly the cards this sweep accepts. Add a card type to one list and not the
 * other and this object stops the build — better than shipping either a setting
 * that does nothing or a card the sweep silently never reaches. Both directions
 * are checked, so neither list can grow alone.
 */
export const CARD_SLA_TYPE_COVERAGE: Record<
    CardSlaType,
    (typeof ADMIN_CARD_VERIFICATION_TYPES)[number]
> &
    Record<(typeof ADMIN_CARD_VERIFICATION_TYPES)[number], CardSlaType> = {
    aadhaar: "aadhaar",
    pan: "pan",
    bank: "bank",
    cibil: "cibil",
    rc: "rc",
};

/** Never process more than this many leads in one tick. */
const MAX_LEADS_PER_TICK = 100;
/** Never auto-verify more than this many stale consents in one tick. */
const MAX_CONSENTS_PER_TICK = 200;

const CARD_NOTE =
    "Auto-accepted by system: no admin action within the SLA window. The verification provider was NOT called.";

/**
 * Consent states that mean "the customer has signed, an admin just hasn't
 * clicked Approve yet". The OTP path has auto-completed straight to `verified`
 * since E-180 and never lands here.
 */
const CONSENT_AWAITING_ADMIN = [
    "esign_completed",
    "admin_review_pending",
    "manual_uploaded",
] as const;

/**
 * Terminal consent states an admin owns. `autoVerifyConsentIfEnabled` must
 * never touch these — an admin rejection is final.
 */
const CONSENT_TERMINAL = ["verified", "rejected", "admin_rejected"] as const;

function clockOf(now?: Date) {
    return now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * Start the consent SLA clock (E-247).
 *
 * Called from the consent save paths the moment a consent reaches a
 * signed-but-unverified state. Stamps `auto_verify_due_at` = now + the
 * configured window, which is what later makes the record eligible for the
 * sweep — and, just as importantly, is what stops the sweep from ever reaching
 * a consent this function did not admit.
 *
 * E-246 verified consent immediately here instead. That gave the admin no
 * window to reject in, and the sweep that backed it selected on
 * `consent_status` alone, so switching the feature on verified every pending
 * consent in the database retroactively. Stamping a deadline fixes both: the
 * human gets the same window they get on the cards, and an unstamped consent is
 * structurally invisible to the sweep.
 *
 * Best-effort by contract: callers fire this from a consent save path, and a
 * failure here must never fail the save.
 */
export async function stampConsentAutoVerifyDeadline(
    leadId: string,
    consentId?: string,
): Promise<number> {
    try {
        const settings = await getKycAutoApprovalSettings();
        if (!settings.enabled || !settings.autoVerifyConsent) return 0;

        const due = new Date(Date.now() + settings.slaMinutes * 60_000);
        const stamped = await db
            .update(consentRecords)
            .set({ auto_verify_due_at: due })
            .where(
                and(
                    eq(consentRecords.lead_id, leadId),
                    consentId ? eq(consentRecords.id, consentId) : undefined,
                    inArray(
                        consentRecords.consent_status,
                        CONSENT_AWAITING_ADMIN as unknown as string[],
                    ),
                    // Never re-arm a clock that is already running, or a later
                    // save would keep pushing the deadline out forever.
                    isNull(consentRecords.auto_verify_due_at),
                ),
            )
            .returning({ id: consentRecords.id });

        return stamped.length;
    } catch (err) {
        console.error(
            `[kyc-auto-approval] failed to stamp consent deadline for lead ${leadId}:`,
            err,
        );
        return 0;
    }
}

/**
 * Verify a signed consent record on the system's behalf, writing exactly what
 * `POST /api/admin/kyc/[leadId]/consent/[consentId]/verify` writes — including
 * the propagation onto `leads` / `co_borrowers` that downstream consumers
 * (case review, dealer page initial load) read instead of re-deriving.
 *
 * @param consentId Restrict to one record. Omit to act on every eligible record
 *                  on the lead.
 */
export async function autoVerifyConsentIfEnabled(
    leadId: string,
    consentId?: string,
    settingsOverride?: KycAutoApprovalSettings,
): Promise<boolean> {
    try {
        const settings = settingsOverride ?? (await getKycAutoApprovalSettings());
        if (!settings.enabled || !settings.autoVerifyConsent) return false;

        const rows = await db
            .select()
            .from(consentRecords)
            .where(
                consentId
                    ? and(
                          eq(consentRecords.id, consentId),
                          eq(consentRecords.lead_id, leadId),
                      )
                    : eq(consentRecords.lead_id, leadId),
            );

        const actionable = rows.filter(
            (r) =>
                r.consent_status != null &&
                (CONSENT_AWAITING_ADMIN as readonly string[]).includes(
                    r.consent_status,
                ) &&
                !(CONSENT_TERMINAL as readonly string[]).includes(r.consent_status),
        );
        if (actionable.length === 0) return false;

        const now = new Date();

        for (const record of actionable) {
            await db
                .update(consentRecords)
                .set({
                    consent_status: "verified",
                    verified_by: null,
                    verification_source: "system",
                    verified_at: now,
                    updated_at: now,
                })
                .where(eq(consentRecords.id, record.id));

            // Mirror the admin route's applicant-level propagation.
            if (record.consent_for === "co_borrower") {
                await db
                    .update(coBorrowers)
                    .set({ consent_status: "verified", updated_at: now })
                    .where(eq(coBorrowers.lead_id, leadId));
                await db
                    .update(leads)
                    .set({ borrower_consent_status: "verified", updated_at: now })
                    .where(eq(leads.id, leadId));
            } else {
                await db
                    .update(leads)
                    .set({ consent_status: "verified", updated_at: now })
                    .where(eq(leads.id, leadId));
            }
        }

        return true;
    } catch (err) {
        console.error(
            `[kyc-auto-approval] consent auto-verify failed for lead ${leadId}:`,
            err,
        );
        return false;
    }
}

// ---------------------------------------------------------------------------
// The per-lead action
// ---------------------------------------------------------------------------

export type AutoApproveOutcome = {
    leadId: string;
    /**
     * `waiting` (E-248) is not a failure: the cards whose windows had closed
     * were accepted and the case is due back when the next one closes. The
     * caller must leave `auto_approved_at` NULL for it and move the pointer on.
     */
    result: "approved" | "blocked" | "waiting";
    cardsAccepted: number;
    docsVerified: number;
    blockers?: string[];
    /** Set on `waiting`: when this case next needs the sweep's attention. */
    nextDueAt?: Date | null;
};

/**
 * The deadlines one queue row is working to (E-248). Read off the row rather
 * than resolved from the settings, so a case keeps the windows it was admitted
 * under. `cardDueAt` is empty for a pre-E-248 row, and every card then falls
 * back to `caseDueAt` — exactly the single-deadline behaviour E-246 shipped.
 */
export type CaseSlaWindows = {
    caseDueAt: Date | null;
    cardDueAt: Partial<Record<CardSlaType, Date>>;
};

/** Parse the `sla_card_due_at` snapshot. Junk in the column is ignored, not thrown on. */
export function parseCardDueAt(raw: unknown): Partial<Record<CardSlaType, Date>> {
    const out: Partial<Record<CardSlaType, Date>> = {};
    if (!raw || typeof raw !== "object") return out;
    const map = raw as Record<string, unknown>;
    for (const type of CARD_SLA_TYPES) {
        const value = map[type];
        if (typeof value !== "string") continue;
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) out[type] = d;
    }
    return out;
}

/** The deadline that applies to one card, with the pre-E-248 fallback. */
function dueAtForCard(type: CardSlaType, windows: CaseSlaWindows): Date | null {
    return windows.cardDueAt[type] ?? windows.caseDueAt;
}

/**
 * Run the automation for one lead whose SLA has expired. The caller is expected
 * to have already claimed the queue row (see `runKycAutoApprovalTick`), so this
 * does not re-check the deadline.
 *
 * With per-card windows (E-248) this can be called several times for the same
 * case — once per distinct window — and returns `waiting` until the last one has
 * closed. It is written to be safe to re-enter: every write is guarded on the
 * row still being untouched by a human, so a card accepted on an earlier visit
 * is not rewritten, and a card an admin has since decided is left alone.
 */
export async function autoApproveLeadKyc(
    leadId: string,
    settings: KycAutoApprovalSettings,
    windows?: CaseSlaWindows,
): Promise<AutoApproveOutcome> {
    const now = new Date();
    let cardsAccepted = 0;
    let docsVerified = 0;

    // No windows passed (older callers, and any case stamped before E-248):
    // treat every card as due now, which is what E-246 did once the case
    // deadline had passed.
    const slaWindows: CaseSlaWindows = windows ?? { caseDueAt: null, cardDueAt: {} };
    const isCardDue = (type: CardSlaType) => {
        const due = dueAtForCard(type, slaWindows);
        return !due || due.getTime() <= now.getTime();
    };
    const dueCardTypes = CARD_SLA_TYPES.filter(isCardDue);
    // Only wait on a card the sweep would actually act on. With card
    // auto-accept switched off nothing is ever accepted, so holding the case
    // back until the longest per-card window closed would delay the dealer for
    // an event that is never going to happen.
    const notYetDueCardTypes = settings.autoApproveCards
        ? CARD_SLA_TYPES.filter((t) => !isCardDue(t))
        : [];

    // 1. Accept the still-pending cards. `admin_action IS NULL` is the whole
    // safety story: a rejected or request_more_docs card is skipped, and so is
    // an already-accepted one (so a re-run cannot restamp a human's verdict as
    // the system's). Covers primary AND co-borrower — the approve gate blocks
    // on both.
    if (settings.autoApproveCards && dueCardTypes.length > 0) {
        const accepted = await db
            .update(kycVerifications)
            .set({
                status: "success",
                admin_action: "accepted",
                admin_action_by: null,
                admin_action_source: "system",
                admin_action_at: now,
                admin_action_notes: CARD_NOTE,
                completed_at: now,
                updated_at: now,
            })
            .where(
                and(
                    eq(kycVerifications.lead_id, leadId),
                    // E-248 — only the cards whose OWN window has closed. A card
                    // still inside its window is left for the human it belongs
                    // to; the sweep comes back for it when that window closes.
                    inArray(
                        kycVerifications.verification_type,
                        dueCardTypes as unknown as string[],
                    ),
                    isNull(kycVerifications.admin_action),
                ),
            )
            .returning({ id: kycVerifications.id });
        cardsAccepted = accepted.length;

        // 1b. Cards that have no row AT ALL. A `kyc_verifications` row is only
        // written when someone runs (or manually decides) that verification, so
        // a case where nobody touched CIBIL or RC simply has no row for them —
        // and an UPDATE cannot accept a row that does not exist. Those two cards
        // therefore sat on `Pending` forever after a sweep that "approved" the
        // case, which is the state this fixes.
        //
        // Mirrors the admin's own manual-accept path
        // (`/api/admin/kyc/[leadId]/verification/manual`), which likewise
        // inserts a terminal row for a card whose API was never run — same
        // shape, so downstream gates and the audit trail keep working
        // uniformly. The differences are the ones that matter: no actor,
        // `admin_action_source='system'`, and an `api_response` that states in
        // its own fields that no provider was called, so nothing downstream can
        // read this as a real bureau pull or RC lookup.
        //
        // PRIMARY ONLY. A co-borrower's cards are only meaningful when a
        // co-borrower exists; inventing rows for one who does not would put
        // five phantom cards on the case.
        const existingTypes = await db
            .select({ type: kycVerifications.verification_type })
            .from(kycVerifications)
            .where(
                and(
                    eq(kycVerifications.lead_id, leadId),
                    sql`${kycVerifications.applicant} IS NOT DISTINCT FROM 'primary'`,
                ),
            );
        const present = new Set(existingTypes.map((r) => r.type));
        const missing = dueCardTypes.filter((t) => !present.has(t));

        if (missing.length > 0) {
            const inserted = await db
                .insert(kycVerifications)
                .values(
                    missing.map((type) => ({
                        id: createWorkflowId("KYCVER", now),
                        lead_id: leadId,
                        verification_type: type,
                        applicant: "primary",
                        status: "success",
                        api_response: {
                            auto_accepted: true,
                            provider_called: false,
                            reason: CARD_NOTE,
                        },
                        submitted_at: now,
                        completed_at: now,
                        admin_action: "accepted",
                        admin_action_by: null,
                        admin_action_source: "system",
                        admin_action_at: now,
                        admin_action_notes: CARD_NOTE,
                        created_at: now,
                        updated_at: now,
                    })),
                )
                .returning({ id: kycVerifications.id });
            cardsAccepted += inserted.length;
        }
    }

    // 1c. E-248 — is anything still inside its own window? If so, stop here:
    // the cards that matured have been accepted, and the case comes back when
    // the next window closes. Approving now would finalise a case while a card
    // an admin still owns is sitting in its review window, which is exactly
    // what per-card windows exist to prevent — and it would also lock the card
    // behind `dealer_edits_locked` before anyone could act on it.
    const caseDueAt = slaWindows.caseDueAt;
    const caseWindowOpen = Boolean(caseDueAt && caseDueAt.getTime() > now.getTime());
    if (notYetDueCardTypes.length > 0 || caseWindowOpen) {
        const upcoming = [
            ...notYetDueCardTypes
                .map((t) => dueAtForCard(t, slaWindows))
                .filter((d): d is Date => Boolean(d)),
            ...(caseWindowOpen && caseDueAt ? [caseDueAt] : []),
        ];
        const nextDueAt = upcoming.reduce<Date | null>(
            (min, d) => (!min || d.getTime() < min.getTime() ? d : min),
            null,
        );
        return { leadId, result: "waiting", cardsAccepted, docsVerified, nextDueAt };
    }

    // 2. Verify the required supporting docs. Optional ones (is_required=false)
    // never block approval, so leave them alone; a rejected one is a human
    // verdict and is left to stand, which is what makes the gate below fail.
    if (settings.autoVerifyRequiredDocs) {
        const verified = await db
            .update(otherDocumentRequests)
            .set({
                upload_status: "verified",
                status: "verified",
                reviewed_by: null,
                review_source: "system",
                reviewed_at: now,
                updated_at: now,
            })
            .where(
                and(
                    eq(otherDocumentRequests.lead_id, leadId),
                    // IS DISTINCT FROM false, not = true: the approve gate
                    // skips only `is_required === false`, so a NULL counts as
                    // required and DOES block. Matching on `= true` here would
                    // leave those rows unverified and every auto-approval on a
                    // lead carrying one would come back `blocked`.
                    sql`${otherDocumentRequests.is_required} IS DISTINCT FROM false`,
                    sql`${otherDocumentRequests.upload_status} IS DISTINCT FROM 'verified'`,
                    sql`${otherDocumentRequests.upload_status} IS DISTINCT FROM 'rejected'`,
                ),
            )
            .returning({ id: otherDocumentRequests.id });
        docsVerified = verified.length;
    }

    // 3. The final decision — the same code path the admin's Approve button
    // runs, so the gate cannot drift and the dealer gets the same notification.
    if (!settings.autoFinalApprove) {
        return {
            leadId,
            result: "blocked",
            cardsAccepted,
            docsVerified,
            blockers: ["Final approve is disabled in KYC automation settings"],
        };
    }

    const decision = await applyKycFinalDecision({
        leadId,
        decision: "approved",
        notes: `Auto-approved by system: no admin action within the ${formatSlaWindow(settings.slaMinutes)} SLA window.`,
        actor: { id: null, source: "system" },
    });

    if (!decision.ok) {
        return {
            leadId,
            result: "blocked",
            cardsAccepted,
            docsVerified,
            blockers: decision.blockers,
        };
    }

    return { leadId, result: "approved", cardsAccepted, docsVerified };
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export type KycAutoApprovalTickResult = {
    ran: boolean;
    reason?: string;
    processed: number;
    approved: number;
    blocked: number;
    /** E-248 — visited, cards accepted, but still inside another card's window. */
    waiting: number;
    consentsVerified: number;
};

/**
 * Claim and process every case whose SLA has expired.
 *
 * THE CLAIM IS THE LOCK. A single UPDATE stamps `auto_approved_at` on the
 * oldest due row via `FOR UPDATE SKIP LOCKED`, so the in-process ticker and a
 * concurrent cron hit can run at the same time without both processing the same
 * lead. Stamping it up front (rather than after the work) also means a case is
 * attempted exactly once whatever the outcome — a lead that legitimately fails
 * the approve gate is not retried on every tick for the rest of its life.
 */
export async function runKycAutoApprovalTick(
    now?: Date,
): Promise<KycAutoApprovalTickResult> {
    const empty: KycAutoApprovalTickResult = {
        ran: false,
        processed: 0,
        approved: 0,
        blocked: 0,
        waiting: 0,
        consentsVerified: 0,
    };

    const settings = await getKycAutoApprovalSettings();
    if (!settings.enabled) {
        return { ...empty, reason: "disabled" };
    }

    const nowSql = clockOf(now);
    let processed = 0;
    let approved = 0;
    let blocked = 0;
    let waiting = 0;

    // E-248 — rows are claimed by MOVING THE POINTER, not by stamping
    // `auto_approved_at`. A case with per-card windows has to be visited once
    // per window, so stamping the finality marker up front (as E-246 did) would
    // end the case at its first, shortest window. Pushing `sla_next_due_at` a
    // minute into the future instead takes the row out of the selection for
    // this tick and any concurrent one, and the row comes back either when its
    // real next deadline arrives (the `waiting` path rewrites the pointer) or
    // after that minute if this process dies mid-work.
    //
    // `auto_approved_at` keeps its old meaning — the sweep has had its one
    // FINAL attempt — and is still stamped in the same statement that reads the
    // row for the terminal pass, so a case is finalised exactly once.
    const claimUntil = sql`${nowSql} + interval '1 minute'`;

    for (let i = 0; i < MAX_LEADS_PER_TICK; i++) {
        const claimed = await db.execute<{
            id: string;
            lead_id: string;
            sla_due_at: string | null;
            sla_card_due_at: unknown;
        }>(sql`
            UPDATE admin_verification_queue
               SET sla_next_due_at = ${claimUntil}, updated_at = ${nowSql}
             WHERE id = (
                   SELECT id FROM admin_verification_queue
                    WHERE status = 'pending_itarang_verification'
                      AND auto_approved_at IS NULL
                      AND COALESCE(sla_next_due_at, sla_due_at) IS NOT NULL
                      AND COALESCE(sla_next_due_at, sla_due_at) <= ${nowSql}
                    ORDER BY COALESCE(sla_next_due_at, sla_due_at) ASC
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
             )
         RETURNING id, lead_id, sla_due_at, sla_card_due_at
        `);

        const row = claimed[0];
        if (!row) break;

        processed++;
        try {
            const windows: CaseSlaWindows = {
                caseDueAt: row.sla_due_at ? new Date(row.sla_due_at) : null,
                cardDueAt: parseCardDueAt(row.sla_card_due_at),
            };
            const outcome = await autoApproveLeadKyc(row.lead_id, settings, windows);

            if (outcome.result === "waiting") {
                // Still inside someone's window. Point the row at the next
                // deadline and leave it open — no finality marker, no audit
                // entry, no notification: nothing has been decided yet.
                waiting++;
                await db
                    .update(adminVerificationQueue)
                    .set({ sla_next_due_at: outcome.nextDueAt ?? null, updated_at: new Date() })
                    .where(eq(adminVerificationQueue.id, row.id));
                continue;
            }

            if (outcome.result === "approved") approved++;
            else blocked++;

            await db
                .update(adminVerificationQueue)
                .set({
                    auto_approved_at: new Date(),
                    auto_approval_result: outcome.result,
                    // Nothing left to come back for.
                    sla_next_due_at: null,
                })
                .where(eq(adminVerificationQueue.id, row.id));

            await recordAudit(row.id, outcome, settings);

            // Tell the admins either way: an approval is an FYI, a blocked case
            // is a call to action that nothing else would surface.
            notifyKycAutoApproved({
                leadId: row.lead_id,
                result: outcome.result,
                slaWindow: formatSlaWindow(settings.slaMinutes),
                cardsAccepted: outcome.cardsAccepted,
                blockers: outcome.blockers,
            }).catch(() => {});
        } catch (err) {
            blocked++;
            console.error(
                `[kyc-auto-approval] lead ${row.lead_id} failed:`,
                err,
            );
            // Close the case out — do not retry a lead that threw, or a
            // deterministic failure becomes an every-tick loop. Under E-248 the
            // pointer claim only holds the row for a minute, so unlike E-246
            // this write is what stops the retry, not just a label: it has to
            // stamp `auto_approved_at` and clear the pointer.
            try {
                await db
                    .update(adminVerificationQueue)
                    .set({
                        auto_approved_at: new Date(),
                        auto_approval_result: "blocked",
                        sla_next_due_at: null,
                    })
                    .where(eq(adminVerificationQueue.id, row.id));
            } catch {
                /* nothing else to try; the next tick will re-attempt this lead */
            }
        }
    }

    const consentsVerified = await sweepDueConsents(settings, nowSql);

    if (processed > 0 || consentsVerified > 0) {
        console.log(
            `[kyc-auto-approval] processed=${processed} approved=${approved} blocked=${blocked} waiting=${waiting} consents=${consentsVerified}`,
        );
    }

    return { ran: true, processed, approved, blocked, waiting, consentsVerified };
}

async function recordAudit(
    queueId: string,
    outcome: AutoApproveOutcome,
    settings: KycAutoApprovalSettings,
): Promise<void> {
    try {
        const stamp = new Date();
        await db.insert(auditLogs).values({
            id: createWorkflowId("AUDIT", stamp),
            entity_type: "kyc_auto_approval",
            entity_id: outcome.leadId,
            action: outcome.result,
            changes: {
                queue_id: queueId,
                sla_minutes: settings.slaMinutes,
                cards_accepted: outcome.cardsAccepted,
                docs_verified: outcome.docsVerified,
                result: outcome.result,
                blockers: outcome.blockers ?? null,
                providers_called: false,
            },
            performed_by: null,
            timestamp: stamp,
        });
    } catch (err) {
        // Non-fatal, exactly as the card-action route treats its audit write:
        // the decision is already committed and a logging failure must not make
        // a successful auto-approval look broken.
        console.error("[kyc-auto-approval] audit insert failed:", err);
    }
}

/**
 * Verify consents whose SLA window has closed (E-247).
 *
 * THE `auto_verify_due_at IS NOT NULL` PREDICATE IS LOAD-BEARING. It is the
 * only thing standing between this sweep and every pending consent in the
 * database. Until E-247 this function selected on `consent_status` alone, and
 * the first time it ran with the feature enabled it verified 14 real consents
 * signed months earlier — the retroactive sweep the rest of E-246 was carefully
 * designed to make impossible. A consent is eligible ONLY if
 * `stampConsentAutoVerifyDeadline` admitted it, which it only does while the
 * feature is on. Never widen this WHERE clause, and never backfill the column.
 *
 * The clock is Postgres's, for the same reason it is everywhere else here.
 */
async function sweepDueConsents(
    settings: KycAutoApprovalSettings,
    nowSql: ReturnType<typeof clockOf>,
): Promise<number> {
    if (!settings.autoVerifyConsent) return 0;

    try {
        const due = await db
            .select({
                id: consentRecords.id,
                lead_id: consentRecords.lead_id,
            })
            .from(consentRecords)
            .where(
                and(
                    isNotNull(consentRecords.auto_verify_due_at),
                    sql`${consentRecords.auto_verify_due_at} <= ${nowSql}`,
                    inArray(
                        consentRecords.consent_status,
                        CONSENT_AWAITING_ADMIN as unknown as string[],
                    ),
                ),
            )
            .limit(MAX_CONSENTS_PER_TICK);

        let verified = 0;
        for (const record of due) {
            const ok = await autoVerifyConsentIfEnabled(
                record.lead_id,
                record.id,
                settings,
            );
            if (ok) verified++;
        }
        return verified;
    } catch (err) {
        console.error("[kyc-auto-approval] consent sweep failed:", err);
        return 0;
    }
}
