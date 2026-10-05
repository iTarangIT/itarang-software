// Dealer agreement status refreshes itself (tracker ID 53, 29 Sep 2026).
//
// Until now the status only moved while someone had the dealer review page open
// (its 10 s poll) or pressed Refresh Status. This sweep asks Digio about every
// initiated, still-open agreement (least recently checked first), through the SAME
// refreshDealerAgreementFromDigio the button uses — so a sweep and a click can
// never record different things, and the per-application throttle ("auto")
// keeps it from racing the page's own poll.
//
// Run in-process by startDealerAgreementRefreshTicker (instrumentation-node.ts),
// with /api/cron/dealer-agreement-refresh as the backstop.

import { and, asc, eq, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { refreshDealerAgreementFromDigio } from "@/lib/agreement/refresh-dealer-agreement";

/** Statuses that never change again on their own — mirrors the review page. */
export const TERMINAL_AGREEMENT_STATUSES = ["completed", "failed", "expired"] as const;

/**
 * Most agreements one sweep asks Digio about. Open agreements are few (tens),
 * so in practice one sweep covers all of them; the cap only bounds a backlog.
 */
export const AGREEMENT_SWEEP_BATCH = 100;

export type AgreementSweepResult = { checked: number; changed: number; failed: number };

export async function runDealerAgreementRefreshSweep(): Promise<AgreementSweepResult> {
    const due = await db
        .select()
        .from(dealerOnboardingApplications)
        .where(
            and(
                isNotNull(dealerOnboardingApplications.provider_document_id),
                or(
                    isNull(dealerOnboardingApplications.agreement_status),
                    notInArray(dealerOnboardingApplications.agreement_status, [...TERMINAL_AGREEMENT_STATUSES]),
                ),
            ),
        )
        // Least recently checked first (tracker ID 53), so a batch that cannot
        // cover the whole backlog rotates through it instead of re-asking
        // about the newest 100 forever. Every attempt, failed ones included,
        // is stamped (markChecked), so permanently failing rows move to the
        // back instead of pinning the front of the queue. Ties (never checked)
        // go oldest first.
        //
        // ID 122: the marker is agreement_last_checked_at (E-327), not
        // updated_at — updated_at fed the onboarding stalled / drop-out clock,
        // so a sweep every 15 minutes kept every unsigned agreement looking
        // freshly worked. Read through to_jsonb so a database without E-327
        // still orders by updated_at, as before.
        .orderBy(
            sql`COALESCE((to_jsonb(dealer_onboarding_applications) ->> 'agreement_last_checked_at')::timestamptz,
                         ${dealerOnboardingApplications.updated_at}) ASC NULLS FIRST`,
            asc(dealerOnboardingApplications.created_at),
        )
        .limit(AGREEMENT_SWEEP_BATCH);

    const result: AgreementSweepResult = { checked: 0, changed: 0, failed: 0 };
    for (const app of due) {
        result.checked++;
        try {
            const before = app.agreement_status;
            const r = await refreshDealerAgreementFromDigio(app, { source: "auto" });
            if (!r.ok) {
                // 429 = refreshed moments ago by the page poll; not a failure.
                if (r.status !== 429) {
                    result.failed++;
                    await markChecked(app.id);
                }
                continue;
            }
            await markChecked(app.id);
            const [after] = await db
                .select({ s: dealerOnboardingApplications.agreement_status })
                .from(dealerOnboardingApplications)
                .where(eq(dealerOnboardingApplications.id, app.id));
            if ((after?.s ?? null) !== (before ?? null)) result.changed++;
        } catch (err) {
            result.failed++;
            console.error(
                `[agreement-sweep] ${app.id} refresh failed:`,
                err instanceof Error ? err.message : err,
            );
            await markChecked(app.id);
        }
    }
    return result;
}

/**
 * Stamp "the sweep looked at this agreement" (tracker ID 53: without it a row
 * Digio keeps rejecting stays at the head of the oldest-first queue and >100
 * of them would starve every other open agreement).
 *
 * ID 122: the stamp goes on agreement_last_checked_at (E-327). Raw SQL, not
 * the Drizzle object, because the column is deliberately not in schema.ts —
 * Drizzle names every column in its statements, so mirroring it would break
 * every read of this table on a database without the migration. There, the
 * UPDATE fails on the unknown column and this falls back to the old marker,
 * updated_at. Best effort: a failure here must not abort the rest of the sweep.
 */
async function markChecked(id: string): Promise<void> {
    try {
        await db.execute(sql`
            UPDATE dealer_onboarding_applications
               SET agreement_last_checked_at = NOW()
             WHERE id = ${id}
        `);
        return;
    } catch {
        // E-327 not applied here — fall through to the pre-ID-122 marker.
    }
    try {
        await db
            .update(dealerOnboardingApplications)
            .set({ updated_at: new Date() })
            .where(eq(dealerOnboardingApplications.id, id));
    } catch (err) {
        console.error(
            `[agreement-sweep] ${id} could not record the failed attempt:`,
            err instanceof Error ? err.message : err,
        );
    }
}
