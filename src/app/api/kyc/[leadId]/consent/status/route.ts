import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { consentRecords } from '@/lib/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';

type RouteContext = {
    params: Promise<{ leadId: string }>;
};

export async function GET(req: NextRequest, { params }: RouteContext) {
    try {
        await requireRole(['dealer', 'admin', 'ceo', 'business_head', 'sales_head']);
        const { leadId } = await params;

        // consent_for: "customer" (Step 2 KYC) or "borrower" (Step 3 Borrower Consent)
        const consentFor = req.nextUrl.searchParams.get('consent_for') || 'primary';
        const dbConsentFor = consentFor === 'customer' ? 'primary' : consentFor;

        const records = await db.select()
            .from(consentRecords)
            .where(and(eq(consentRecords.lead_id, leadId), eq(consentRecords.consent_for, dbConsentFor)))
            .orderBy(desc(consentRecords.updated_at))
            .limit(1);

        if (!records.length) {
            return NextResponse.json({ success: true, data: null });
        }

        const record = records[0];
        return NextResponse.json({
            success: true,
            data: {
                id: record.id,
                consent_status: record.consent_status,
                consent_type: record.consent_type,
                consent_for: record.consent_for,
                sign_method: record.sign_method,
                signed_at: record.signed_at,
                signed_consent_url: record.signed_consent_url,
                generated_pdf_url: record.generated_pdf_url,
                signer_aadhaar_masked: record.signer_aadhaar_masked,
                esign_provider: record.esign_provider,
                consent_link_sent_at: record.consent_link_sent_at,
                consent_link_expires_at: record.consent_link_expires_at,
                consent_delivery_channel: record.consent_delivery_channel,
                esign_error_message: record.esign_error_message,
                rejection_reason: record.rejection_reason,
                reviewer_notes: record.reviewer_notes,
                verified_at: record.verified_at,
                rejected_at: record.rejected_at,
                updated_at: record.updated_at,
            },
        });
    } catch (error) {
        console.error('[Consent Status] Error:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch consent status';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
