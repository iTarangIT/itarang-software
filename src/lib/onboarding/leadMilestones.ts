/**
 * Tracker ID 84.2 — onboarding milestones written onto the dealer lead
 * (E-314 columns, NOT in schema.ts — raw SQL):
 *
 *   dealer_leads.onboarding_docs_submitted_at   the FIRST submission of the
 *                                                dealer's documents (COALESCE —
 *                                                a resubmission never moves it)
 *   dealer_leads.agreement_outcome               the latest agreement result:
 *                                                completed / failed / cancelled
 *                                                / expired (last write wins —
 *                                                a failed agreement re-sent and
 *                                                signed ends "completed")
 *
 * The lead is the one the application came from: dealer_leads.
 * dealer_onboarding_application_id, or the application's
 * originating_dealer_lead_id while that lead is still Won / Converted — a lead
 * re-engaged after a drop-out is unlinked (ID 84.4) and must not pick up the
 * old application's events. An application with no lead is a no-op.
 *
 * BEST-EFFORT. These are reporting stamps on the side of an onboarding write
 * that has already happened; a host without E-314, or any other failure, logs
 * and returns — it must never fail the submission, the upload or the webhook.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

export type AgreementOutcome = "completed" | "failed" | "cancelled" | "expired";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** WHERE fragment over dealer_leads `dl` for the lead(s) behind an application. */
function leadsOfApplication(applicationId: string) {
    return sql`(
        dl.dealer_onboarding_application_id = ${applicationId}::uuid
        OR (dl.lead_status IN ('Won', 'Converted')
            AND dl.id = (SELECT oa.originating_dealer_lead_id
                           FROM dealer_onboarding_applications oa
                          WHERE oa.id = ${applicationId}::uuid))
    )`;
}

/** First submission of the dealer's onboarding documents. */
export async function markDocsSubmitted(applicationId: string | null | undefined): Promise<void> {
    if (!applicationId || !UUID_RE.test(applicationId)) return;
    try {
        await db.execute(sql`
            UPDATE dealer_leads dl
               SET onboarding_docs_submitted_at = COALESCE(dl.onboarding_docs_submitted_at, NOW())
             WHERE ${leadsOfApplication(applicationId)}
        `);
    } catch (e) {
        console.warn("[leadMilestones] markDocsSubmitted failed", {
            applicationId,
            error: e instanceof Error ? e.message : String(e),
        });
    }
}

/** The agreement's latest outcome, by application or directly by lead. */
export async function markAgreementOutcome(
    target: { applicationId: string } | { dealerLeadId: string },
    outcome: AgreementOutcome,
): Promise<void> {
    try {
        if ("applicationId" in target) {
            if (!target.applicationId || !UUID_RE.test(target.applicationId)) return;
            await db.execute(sql`
                UPDATE dealer_leads dl
                   SET agreement_outcome = ${outcome}
                 WHERE ${leadsOfApplication(target.applicationId)}
                   AND dl.agreement_outcome IS DISTINCT FROM ${outcome}
            `);
        } else {
            if (!target.dealerLeadId) return;
            await db.execute(sql`
                UPDATE dealer_leads dl
                   SET agreement_outcome = ${outcome}
                 WHERE dl.id = ${target.dealerLeadId}
                   AND dl.agreement_outcome IS DISTINCT FROM ${outcome}
            `);
        }
    } catch (e) {
        console.warn("[leadMilestones] markAgreementOutcome failed", {
            target,
            outcome,
            error: e instanceof Error ? e.message : String(e),
        });
    }
}
