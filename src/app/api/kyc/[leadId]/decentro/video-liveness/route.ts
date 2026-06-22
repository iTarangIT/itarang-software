import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { isS3Backend, putObject, filesProxyPath } from '@/lib/storage/s3';
import { videoLiveness } from '@/lib/decentro';
import { db } from '@/lib/db';
import { kycVerifications } from '@/lib/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { createWorkflowId } from '@/lib/kyc/admin-workflow';

const MAX_VIDEO_BYTES = 25 * 1024 * 1024; // 25 MB — accommodates ~10s @ 720p MediaRecorder webm
// MediaRecorder hands back MIME types like "video/webm;codecs=vp9,opus" — match
// on the base type (before the optional `;codecs=…` parameter) so codec hints
// don't fail the allowlist.
const ALLOWED_BASE_TYPES = ['video/webm', 'video/mp4', 'video/quicktime', 'video/x-matroska'];
function baseMime(t: string): string {
    return (t || '').split(';')[0].trim().toLowerCase();
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            return NextResponse.json({ success: false, error: { message: 'Unauthorized' } }, { status: 401 });
        }

        const { leadId } = await params;

        const formData = await req.formData();
        const video = formData.get('video') as File | null;
        const applicantRaw = (formData.get('applicant') as string) || 'primary';
        const applicant = applicantRaw === 'co_borrower' ? 'co_borrower' : 'primary';

        if (!video) {
            return NextResponse.json(
                { success: false, error: { message: 'video file is required' } },
                { status: 400 },
            );
        }
        if (video.size > MAX_VIDEO_BYTES) {
            return NextResponse.json(
                { success: false, error: { message: `Video must be ${MAX_VIDEO_BYTES / 1024 / 1024}MB or smaller` } },
                { status: 413 },
            );
        }
        const incomingType = video.type || '';
        const base = baseMime(incomingType);
        if (base && !ALLOWED_BASE_TYPES.includes(base)) {
            return NextResponse.json(
                { success: false, error: { message: `Unsupported video type: ${incomingType}` } },
                { status: 415 },
            );
        }

        // Pick a filename extension from the base mime (browser-supplied filenames
        // are often missing or generic for MediaRecorder blobs).
        const extFromMime: Record<string, string> = {
            'video/webm': 'webm',
            'video/mp4': 'mp4',
            'video/quicktime': 'mov',
            'video/x-matroska': 'mkv',
        };
        const ext = extFromMime[base] || 'webm';
        const fileName = `kyc/${leadId}/video_kyc_${applicant}_${Date.now()}.${ext}`;
        const buffer = Buffer.from(await video.arrayBuffer());

        // Upload with the BASE content-type (Supabase + most browsers play the
        // file fine without the codec hint, and some CDN/proxy stacks reject
        // contentType values containing semicolons).
        let videoUrl: string;
        if (isS3Backend) {
            await putObject('documents', fileName, buffer, base || 'video/webm');
            videoUrl = filesProxyPath('documents', fileName);
        } else {
            const { error: uploadError } = await supabase.storage
                .from('documents')
                .upload(fileName, buffer, { contentType: base || 'video/webm', upsert: true });

            if (uploadError) {
                return NextResponse.json(
                    { success: false, error: { message: `Storage upload failed: ${uploadError.message}` } },
                    { status: 500 },
                );
            }

            const { data: urlData } = supabase.storage.from('documents').getPublicUrl(fileName);
            videoUrl = urlData.publicUrl;
        }

        const blob = new Blob([buffer], { type: base || 'video/webm' });
        const decentroRes = await videoLiveness(blob, 'Customer video liveness for loan KYC', `liveness.${ext}`);

        const decentroOk = decentroRes.responseStatus === 'SUCCESS' || decentroRes.status === 'SUCCESS';
        const dataInner = (decentroRes.data || {}) as { status?: string; confidence?: string | number };
        const livenessPassed = (dataInner.status || '').toUpperCase() === 'SUCCESS';
        const confidenceNum = typeof dataInner.confidence === 'number'
            ? dataInner.confidence
            : parseFloat(String(dataInner.confidence || '0')) || 0;

        // Even when Decentro returns SUCCESS+high confidence, we keep status
        // 'admin_review_pending'. Passive liveness alone does not prove identity
        // (it confirms the subject is a live human, not which person). The
        // admin still needs to play the recording back and confirm the face
        // matches the customer's other KYC photos before accepting.
        // A genuine Decentro FAILURE (or low confidence) is flagged as failed
        // so the dealer is prompted to re-record without admin intervention.
        const passiveOk = decentroOk && livenessPassed && confidenceNum >= 0.5;
        const persistedStatus = passiveOk ? 'admin_review_pending' : 'failed';
        const failedReason = passiveOk
            ? null
            : (decentroRes.message || `Liveness check failed (confidence: ${confidenceNum})`);

        // Replace any prior video_kyc row for the same applicant — dealer
        // re-records overwrite the previous attempt rather than creating
        // history rows. The verifications GET route already dedupes by
        // canonical type, but a single row keeps the audit clean.
        const [existing] = await db
            .select({ id: kycVerifications.id })
            .from(kycVerifications)
            .where(and(
                eq(kycVerifications.lead_id, leadId),
                eq(kycVerifications.verification_type, 'video_kyc'),
                eq(kycVerifications.applicant, applicant),
            ))
            .orderBy(desc(kycVerifications.updated_at))
            .limit(1);

        const now = new Date();
        // match_score is numeric(5,2) — store 0.00-100.00 (scaled %)
        const scoreStr = (confidenceNum * 100).toFixed(2);
        const apiResponse = {
            video_url: videoUrl,
            decentro: decentroRes,
        } as unknown as Record<string, unknown>;

        if (existing) {
            await db
                .update(kycVerifications)
                .set({
                    status: persistedStatus,
                    api_provider: 'decentro_video_liveness',
                    api_response: apiResponse,
                    failed_reason: failedReason,
                    match_score: scoreStr,
                    submitted_at: now,
                    completed_at: now,
                    updated_at: now,
                    admin_action: null,
                    admin_action_by: null,
                    admin_action_at: null,
                    admin_action_notes: null,
                })
                .where(eq(kycVerifications.id, existing.id));
        } else {
            await db.insert(kycVerifications).values({
                id: createWorkflowId('KYCVER', now),
                lead_id: leadId,
                verification_type: 'video_kyc',
                applicant,
                verification_for: applicant === 'co_borrower' ? 'borrower' : 'customer',
                status: persistedStatus,
                api_provider: 'decentro_video_liveness',
                api_response: apiResponse,
                failed_reason: failedReason,
                match_score: scoreStr,
                submitted_at: now,
                completed_at: now,
            });
        }

        return NextResponse.json({
            success: passiveOk,
            status: persistedStatus,
            confidence: confidenceNum,
            video_url: videoUrl,
            message: decentroRes.message || (passiveOk ? 'Liveness check passed — awaiting admin review' : 'Liveness check failed'),
            failed_reason: failedReason,
        });
    } catch (error) {
        console.error('[KYC video-liveness] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
