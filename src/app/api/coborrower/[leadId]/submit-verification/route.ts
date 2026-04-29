import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
    adminVerificationQueue,
    kycVerifications,
    leads,
} from '@/lib/db/schema';
import { createWorkflowId } from '@/lib/kyc/admin-workflow';

// BRD §2.9.3 step 5 — When dealer submits Step 3 (co-borrower KYC), the
// lead must move to 'pending_itarang_reverification' and a high-priority
// row must land in adminVerificationQueue so the admin sees it.

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;

        const verificationTypes = ['aadhaar', 'pan', 'bank', 'address', 'mobile'];
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');

        const verifications = [];
        for (const type of verificationTypes) {
            const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
            await db.insert(kycVerifications).values({
                id: `KYCVER-COB-${dateStr}-${seq}`,
                lead_id: leadId,
                verification_type: `coborrower_${type}`,
                status: 'initiating',
                api_provider: 'decentro',
                submitted_at: now,
                created_at: now,
                updated_at: now,
            });

            verifications.push({
                type: `coborrower_${type}`,
                label: `Co-Borrower ${type.charAt(0).toUpperCase() + type.slice(1)} Verification`,
                status: 'initiating',
                last_update: now.toISOString(),
                failed_reason: null,
            });
        }

        // BRD: lead.kyc_status -> 'pending_itarang_reverification'
        await db
            .update(leads)
            .set({
                kyc_status: 'pending_itarang_reverification',
                updated_at: now,
            })
            .where(eq(leads.id, leadId));

        // BRD: high-priority entry in admin queue so re-verification is surfaced
        await db.insert(adminVerificationQueue).values({
            id: createWorkflowId('ADMQ', now),
            queue_type: 'kyc_verification',
            lead_id: leadId,
            status: 'pending_itarang_verification',
            priority: 'high',
            submitted_at: now,
            created_at: now,
            updated_at: now,
        });

        // TODO: Trigger actual third-party API calls

        return NextResponse.json({
            success: true,
            verificationsInitiated: verificationTypes.length,
            verifications,
            new_kyc_status: 'pending_itarang_reverification',
        });
    } catch (error) {
        console.error('[Co-borrower Submit Verification] Error:', error);
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
