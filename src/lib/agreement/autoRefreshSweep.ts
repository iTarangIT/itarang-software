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
        // Least recently checked first (tracker ID 53): every successful
        // refresh stamps updated_at, so a batch that cannot cover the whole
        // backlog rotates through it instead of re-asking about the newest
        // 100 forever. Ties (never refreshed) go oldest first.
        .orderBy(
            sql`${dealerOnboardingApplications.updated_at} ASC NULLS FIRST`,
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
                if (r.status !== 429) result.failed++;
                continue;
            }
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
        }
    }
    return result;
}
