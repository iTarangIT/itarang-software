import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { kycVerifications, leads } from '@/lib/db/schema';
import { sendKycSms } from '@/lib/sms';
import { createClient } from '@/lib/supabase/server';

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
            return NextResponse.json(
                { success: false, error: { message: 'No Active Video KYC session for this lead — initiate first.' } },
                { status: 404 },
            );
        }

        const ar = (row.api_response ?? {}) as Record<string, unknown>;
        const videoLivenessUrl = typeof ar.video_liveness_url === 'string' ? ar.video_liveness_url : '';
        const reference_id = typeof ar.reference_id === 'string' ? ar.reference_id : undefined;

        if (!videoLivenessUrl) {
            return NextResponse.json(
                { success: false, error: { message: 'No videoLivenessUrl on file — initiate a new session.' } },
                { status: 410 },
            );
        }

        // Don't resend if the customer has already completed the session.
        if (row.status && ['admin_review_pending', 'success', 'failed'].includes(row.status)) {
            return NextResponse.json(
                {
                    success: false,
                    error: { message: 'Session is past the customer-action stage; resend not allowed.' },
                },
                { status: 409 },
            );
        }

        // Re-resolve the phone in case the lead was updated.
        const [lead] = await db
            .select({
                phone: leads.phone,
                owner_contact: leads.owner_contact,
                mobile: leads.mobile,
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

        const priorSms = (ar.sms ?? {}) as Record<string, unknown>;
        const attempts = typeof priorSms.attempts === 'number' ? priorSms.attempts + 1 : 2;
        const now = new Date();

        await db
            .update(kycVerifications)
            .set({
                api_response: {
                    ...ar,
                    sms: {
                        attempts,
                        status: smsStatus,
                        message_id: sms.messageId,
                        sent_at: now.toISOString(),
                        error: sms.error,
                    },
                } as unknown as Record<string, unknown>,
                updated_at: now,
            })
            .where(eq(kycVerifications.id, row.id));

        return NextResponse.json({
            success: sms.success,
            data: {
                smsStatus,
                smsError: sms.error,
                smsAttempts: attempts,
                phone,
                videoLivenessUrl,
            },
        });
    } catch (error) {
        console.error('[Active VKYC resend-sms] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
