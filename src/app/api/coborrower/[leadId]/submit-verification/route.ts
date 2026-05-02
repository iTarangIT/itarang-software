import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
    adminVerificationQueue,
    coBorrowers,
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

        // Admin only acts on aadhaar/pan/bank for the co-borrower. Address
        // and mobile rows used to be inserted as placeholders but cluttered
        // the dealer's Verification Status table with rows admin never
        // touches — see CONSENT_AUDIT_TYPES comment in
        // src/app/api/kyc/[leadId]/verifications/route.ts.
        const verificationTypes = ['aadhaar', 'pan', 'bank'];
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');

        // Idempotent: if the dealer re-submits (or admin re-opened the case
        // and the dealer hits Submit again), we must NOT clobber an already
        // verified row with a new 'initiating' placeholder. Insert rows with
        // canonical type names ('aadhaar', 'pan', 'bank' — no 'coborrower_'
        // prefix) so admin's upsertCoBorrowerVerification (in
        // src/lib/kyc/coborrower-verification.ts) updates THIS row instead
        // of creating a parallel one. Skip the insert entirely if a row of
        // that canonical type already exists for this co-borrower (covers
        // re-submission and legacy 'coborrower_*' rows).
        const existingRows = await db
            .select({ verification_type: kycVerifications.verification_type })
            .from(kycVerifications)
            .where(and(
                eq(kycVerifications.lead_id, leadId),
                eq(kycVerifications.applicant, 'co_borrower'),
                inArray(
                    kycVerifications.verification_type,
                    [
                        'aadhaar', 'pan', 'bank',
                        'coborrower_aadhaar', 'coborrower_pan', 'coborrower_bank',
                    ],
                ),
            ));
        const canonicalExisting = new Set(
            existingRows.map(r =>
                r.verification_type.startsWith('coborrower_')
                    ? r.verification_type.slice('coborrower_'.length)
                    : r.verification_type,
            ),
        );

        const verifications = [];
        for (const type of verificationTypes) {
            if (canonicalExisting.has(type)) continue;
            const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
            await db.insert(kycVerifications).values({
                id: `KYCVER-COB-${dateStr}-${seq}`,
                lead_id: leadId,
                applicant: 'co_borrower',
                verification_type: type,
                status: 'initiating',
                api_provider: 'decentro',
                submitted_at: now,
                created_at: now,
                updated_at: now,
            });

            verifications.push({
                type,
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

        // Stamp the co-borrower as submitted so the admin case-review API
        // and the doc-review endpoint know the dealer has formally handed
        // off Step 3. Until this column is non-null, admin sees a gated
        // banner and cannot approve/reject documents.
        await db
            .update(coBorrowers)
            .set({
                verification_submitted_at: now,
                kyc_status: 'submitted',
                updated_at: now,
            })
            .where(eq(coBorrowers.lead_id, leadId));

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
