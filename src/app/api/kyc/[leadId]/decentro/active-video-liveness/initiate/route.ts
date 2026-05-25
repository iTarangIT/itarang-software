import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { kycVerifications, leads } from '@/lib/db/schema';
import { createWorkflowId } from '@/lib/kyc/admin-workflow';
import { getCustomerFaceImagesForLead } from '@/lib/kyc/active-vkyc-images';
import { createClient } from '@/lib/supabase/server';
import { activeVideoLivenessInitiate } from '@/lib/decentro';
import { publicOrigin, PublicOriginError } from '@/lib/public-origin';
import { sendKycSms } from '@/lib/sms';

function buildSmsMessage(url: string): string {
    return `Complete Video KYC for your Itarang loan: ${url} (valid 24h)`;
}

export async function POST(
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

        // Resolve public origin for redirect/callback URLs that Decentro can reach.
        let origin: string;
        try {
            origin = publicOrigin({ req });
        } catch (err) {
            const msg = err instanceof PublicOriginError ? err.message : 'Cannot determine public origin';
            return NextResponse.json(
                { success: false, error: { message: `Server misconfig: ${msg}` } },
                { status: 500 },
            );
        }

        // Pull face images for matching
        const images = await getCustomerFaceImagesForLead(leadId);
        if (images.urls.length + images.base64s.length === 0) {
            return NextResponse.json(
                {
                    success: false,
                    error: {
                        message: 'No face images available for Decentro matching',
                        missing: images.missing,
                    },
                },
                { status: 400 },
            );
        }

        // Lead phone — for the SMS
        const [lead] = await db
            .select({
                phone: leads.phone,
                owner_contact: leads.owner_contact,
                mobile: leads.mobile,
                owner_name: leads.owner_name,
            })
            .from(leads)
            .where(eq(leads.id, leadId))
            .limit(1);

        const rawPhone = (lead?.phone || lead?.owner_contact || lead?.mobile || '').toString();
        const phone = rawPhone.replace(/\D/g, '').slice(-10);
        if (phone.length !== 10) {
            return NextResponse.json(
                { success: false, error: { message: 'Customer phone number is missing or invalid' } },
                { status: 400 },
            );
        }

        // Build a deterministic-ish reference id (used by both initiate and results fetch)
        const refTs = Date.now().toString(36).toUpperCase();
        const refRand = Math.random().toString(36).slice(2, 7).toUpperCase();
        const reference_id = `ITR-AVL-${leadId.slice(-12)}-${refTs}-${refRand}`;

        const decentroRes = await activeVideoLivenessInitiate({
            reference_id,
            redirect_url: `${origin}/api/kyc/decentro/active-video-liveness/return`,
            callback_url: `${origin}/api/kyc/decentro/active-video-liveness/callback`,
            face_image_urls: images.urls,
            face_image_base64s: images.base64s,
            consent_purpose: 'Customer identity verification for loan',
        });

        const ok =
            decentroRes.status === 'SUCCESS' ||
            decentroRes.responseStatus === 'SUCCESS';
        const videoLivenessUrl = decentroRes.videoLivenessUrl || '';
        const decentroTxnId = decentroRes.decentroTxnId || '';

        if (!ok || !videoLivenessUrl || !decentroTxnId) {
            return NextResponse.json(
                {
                    success: false,
                    error: {
                        message: decentroRes.message || 'Decentro Active Liveness initiate failed',
                        decentro: decentroRes,
                    },
                },
                { status: 502 },
            );
        }

        // Send the link to the customer via SMS
        const sms = await sendKycSms({
            mobile_number: phone,
            message: buildSmsMessage(videoLivenessUrl),
            reference_id,
            templateParams: [videoLivenessUrl, '24'],
        });

        const smsStatus = sms.success
            ? ('delivered' as const)
            : sms.skipped
                ? ('skipped' as const)
                : ('failed' as const);

        // Upsert kyc_verifications row keyed by (lead_id, verification_type, applicant)
        const [existing] = await db
            .select({ id: kycVerifications.id })
            .from(kycVerifications)
            .where(and(
                eq(kycVerifications.lead_id, leadId),
                eq(kycVerifications.verification_type, 'active_video_kyc'),
                eq(kycVerifications.applicant, 'primary'),
            ))
            .orderBy(desc(kycVerifications.updated_at))
            .limit(1);

        const now = new Date();
        const apiResponse = {
            decentro_txn_id: decentroTxnId,
            reference_id,
            video_liveness_url: videoLivenessUrl,
            face_image_sources: images.sources,
            initiate_response: decentroRes,
            sms: {
                attempts: 1,
                status: smsStatus,
                message_id: sms.messageId,
                sent_at: now.toISOString(),
                error: sms.error,
            },
        } as unknown as Record<string, unknown>;

        if (existing) {
            await db
                .update(kycVerifications)
                .set({
                    status: 'awaiting_customer',
                    api_provider: 'decentro_active_liveness',
                    api_response: apiResponse,
                    failed_reason: null,
                    match_score: null,
                    submitted_at: now,
                    completed_at: null,
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
                verification_type: 'active_video_kyc',
                applicant: 'primary',
                verification_for: 'customer',
                status: 'awaiting_customer',
                api_provider: 'decentro_active_liveness',
                api_response: apiResponse,
                submitted_at: now,
            });
        }

        return NextResponse.json({
            success: true,
            data: {
                decentroTxnId,
                referenceId: reference_id,
                videoLivenessUrl,
                smsStatus,
                smsError: sms.error,
                phone,
                face_image_sources: images.sources,
            },
        });
    } catch (error) {
        console.error('[Active VKYC initiate] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
