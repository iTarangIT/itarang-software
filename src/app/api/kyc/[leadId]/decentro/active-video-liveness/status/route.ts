import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { kycVerifications } from '@/lib/db/schema';
import { activeVideoLivenessResult } from '@/lib/decentro';
import { createClient } from '@/lib/supabase/server';

function pickBestMatchScore(results: unknown): number | null {
    const arr = (results as { videoFaceMatchResults?: Array<{ results?: { matchScore?: number } }> } | null)
        ?.videoFaceMatchResults;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    let best = -1;
    for (const r of arr) {
        const s = r?.results?.matchScore;
        if (typeof s === 'number' && s > best) best = s;
    }
    return best >= 0 ? best : null;
}

function isTrueish(v: unknown): boolean {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v.toLowerCase() === 'true';
    return false;
}

function buildFailedReason(data: { liveliness?: unknown; staticRisk?: unknown; prerecordedRisk?: unknown } | undefined): string | null {
    if (!data) return null;
    const reasons: string[] = [];
    const live = (data.liveliness ?? '').toString().toLowerCase();
    if (live && live !== 'yes') reasons.push(`liveliness=${live}`);
    if (isTrueish(data.staticRisk)) reasons.push('staticRisk');
    if (isTrueish(data.prerecordedRisk)) reasons.push('prerecordedRisk');
    return reasons.length > 0 ? `Decentro flagged: ${reasons.join(', ')}` : null;
}

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ leadId: string }> },
) {
    try {
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            return NextResponse.json({ success: false, error: { message: 'Unauthorized' } }, { status: 401 });
        }

        const { leadId } = await params;

        const [row] = await db
            .select()
            .from(kycVerifications)
            .where(and(
                eq(kycVerifications.lead_id, leadId),
                eq(kycVerifications.verification_type, 'active_video_kyc'),
                eq(kycVerifications.applicant, 'primary'),
            ))
            .orderBy(desc(kycVerifications.updated_at))
            .limit(1);

        if (!row) {
            return NextResponse.json({
                success: true,
                data: {
                    state: 'not_initiated',
                    status: null,
                    last_update: null,
                    failed_reason: null,
                    sms: null,
                    results: null,
                    videoLivenessUrl: null,
                },
            });
        }

        const ar = (row.api_response ?? {}) as Record<string, unknown>;
        const decentroTxnId = typeof ar.decentro_txn_id === 'string' ? ar.decentro_txn_id : '';
        const reference_id = typeof ar.reference_id === 'string' ? ar.reference_id : '';
        const callbackReceivedAt = ar.callback_received_at as string | undefined;
        const persistedResults = ar.results as Record<string, unknown> | undefined;

        // Fetch results from Decentro once the customer's session has completed
        // (Decentro hit our /callback route → callback_received_at is set) AND we
        // have not yet persisted the results payload.
        const shouldFetch = !!callbackReceivedAt && !persistedResults && decentroTxnId && reference_id;
        const adminVerified = row.admin_action === 'accepted';
        const adminRejected = row.admin_action === 'rejected';

        if (shouldFetch) {
            const decentroRes = await activeVideoLivenessResult(decentroTxnId, reference_id);
            const ok = decentroRes.status === 'SUCCESS' || decentroRes.responseStatus === 'SUCCESS';
            const resultData = decentroRes.data;
            const bestScore = pickBestMatchScore(resultData);
            const failedReason = ok ? buildFailedReason(resultData) : (decentroRes.message || 'Decentro result fetch failed');

            const next = ok && !failedReason
                ? 'admin_review_pending'
                : ok
                    ? 'failed'
                    : 'failed';

            const now = new Date();
            const merged = {
                ...ar,
                results: resultData ?? null,
                result_response: decentroRes,
                results_fetched_at: now.toISOString(),
            } as Record<string, unknown>;

            await db
                .update(kycVerifications)
                .set({
                    status: next,
                    api_response: merged,
                    failed_reason: failedReason,
                    match_score: bestScore !== null ? bestScore.toFixed(2) : null,
                    completed_at: now,
                    updated_at: now,
                })
                .where(eq(kycVerifications.id, row.id));

            return NextResponse.json({
                success: true,
                data: {
                    state: next,
                    status: next,
                    last_update: now.toISOString(),
                    failed_reason: failedReason,
                    sms: ar.sms ?? null,
                    results: resultData ?? null,
                    bestMatchScore: bestScore,
                    videoLivenessUrl: typeof ar.video_liveness_url === 'string' ? ar.video_liveness_url : null,
                    decentroTxnId,
                    adminAction: row.admin_action,
                },
            });
        }

        // No Decentro fetch needed — just echo current DB state
        const stateLabel = adminVerified
            ? 'verified'
            : adminRejected
                ? 'rejected'
                : (row.status || 'awaiting_customer');

        return NextResponse.json({
            success: true,
            data: {
                state: stateLabel,
                status: row.status,
                last_update: row.updated_at?.toISOString() ?? null,
                failed_reason: row.failed_reason ?? null,
                sms: ar.sms ?? null,
                results: persistedResults ?? null,
                bestMatchScore: row.match_score ? Number(row.match_score) : null,
                videoLivenessUrl: typeof ar.video_liveness_url === 'string' ? ar.video_liveness_url : null,
                decentroTxnId,
                adminAction: row.admin_action,
                callback_received_at: callbackReceivedAt ?? null,
            },
        });
    } catch (error) {
        console.error('[Active VKYC status] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
