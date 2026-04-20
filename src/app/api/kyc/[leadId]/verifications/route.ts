import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { kycVerifications } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;
        const verificationFor = req.nextUrl.searchParams.get('verification_for') || 'customer';
        const applicant = verificationFor === 'borrower' ? 'co_borrower' : 'primary';

        const verifications = await db
            .select()
            .from(kycVerifications)
            .where(and(eq(kycVerifications.lead_id, leadId), eq(kycVerifications.applicant, applicant)));

        const LABELS: Record<string, string> = {
            aadhaar: 'Aadhaar Verification',
            pan: 'PAN Verification',
            bank: 'Bank Verification',
            address: 'Address Proof',
            rc: 'RC Verification',
            mobile: 'Mobile Number',
            cibil: 'CIBIL Score',
            photo: 'Photo Verification',
        };

        const data = verifications.map(v => ({
            type: v.verification_type,
            label: LABELS[v.verification_type] || v.verification_type,
            status: v.status,
            last_update: v.updated_at?.toISOString() || null,
            failed_reason: v.failed_reason,
        }));

        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('[KYC Verifications] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
