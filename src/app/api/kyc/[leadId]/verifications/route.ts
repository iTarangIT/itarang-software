import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { consentRecords, kycVerifications } from '@/lib/db/schema';
import { and, desc, eq, notInArray } from 'drizzle-orm';

// esign_consent / esign_consent_sync rows in kyc_verifications are raw DigiO
// audit logs written by send-consent and consent/sync. They are not
// user-facing verification checks — the Customer Consent card on the KYC page
// already reflects the live consent state. Hide them from this list and emit
// a single synthesized row only after admin verification.
const CONSENT_AUDIT_TYPES = ['esign_consent', 'esign_consent_sync'];
const ADMIN_VERIFIED_CONSENT_STATUSES = ['admin_verified', 'manual_verified', 'verified'];

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;
        const verificationFor = req.nextUrl.searchParams.get('verification_for') || 'customer';
        const applicant = verificationFor === 'borrower' ? 'co_borrower' : 'primary';

        const verifications = await db
            .select()
            .from(kycVerifications)
            .where(and(
                eq(kycVerifications.lead_id, leadId),
                eq(kycVerifications.applicant, applicant),
                notInArray(kycVerifications.verification_type, CONSENT_AUDIT_TYPES),
            ));

        const LABELS: Record<string, string> = {
            aadhaar: 'Aadhaar Verification',
            pan: 'PAN Verification',
            bank: 'Bank Verification',
            address: 'Address Proof',
            rc: 'RC Verification',
            mobile: 'Mobile Number',
            cibil: 'CIBIL Score',
            photo: 'Photo Verification',
            esign_consent: 'Customer Consent',
        };

        const data = verifications.map(v => ({
            type: v.verification_type,
            label: LABELS[v.verification_type] || v.verification_type,
            status: v.status,
            last_update: v.updated_at?.toISOString() || null,
            failed_reason: v.failed_reason,
        }));

        const [consent] = await db
            .select()
            .from(consentRecords)
            .where(and(
                eq(consentRecords.lead_id, leadId),
                eq(consentRecords.consent_for, applicant),
            ))
            .orderBy(desc(consentRecords.updated_at))
            .limit(1);

        if (consent && ADMIN_VERIFIED_CONSENT_STATUSES.includes(consent.consent_status)) {
            data.push({
                type: 'esign_consent',
                label: LABELS.esign_consent,
                status: 'success',
                last_update: (consent.verified_at ?? consent.updated_at)?.toISOString() || null,
                failed_reason: null,
            });
        }

        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('[KYC Verifications] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
