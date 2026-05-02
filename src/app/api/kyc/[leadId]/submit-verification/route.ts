import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { kycVerifications, kycDocuments, leads, couponCodes, adminVerificationQueue, consentRecords } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { validateDocument, verifyBankAccount } from '@/lib/decentro';
import { createWorkflowId, getOpenQueueEntryForLead } from '@/lib/kyc/admin-workflow';

const VERIFICATION_LABELS: Record<string, string> = {
    aadhaar: 'Aadhaar Verification',
    pan: 'PAN Verification',
    bank: 'Bank Verification',
    address: 'Address Proof',
    rc: 'RC Verification',
    mobile: 'Mobile Number',
};

async function upsertVerification(leadId: string, type: string, values: Record<string, unknown>) {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');

    // submit-verification is the dealer-side primary submit flow — always
    // scope the upsert by applicant='primary' so it cannot collide with or
    // overwrite a co-borrower row for the same lead/type.
    const existing = await db.select({ id: kycVerifications.id })
        .from(kycVerifications)
        .where(and(
            eq(kycVerifications.lead_id, leadId),
            eq(kycVerifications.verification_type, type),
            eq(kycVerifications.applicant, 'primary'),
        ))
        .limit(1);

    if (existing.length > 0) {
        await db.update(kycVerifications).set({ ...values, updated_at: now })
            .where(eq(kycVerifications.id, existing[0].id));
        return existing[0].id;
    } else {
        const id = `KYCVER-${dateStr}-${seq}`;
        await db.insert(kycVerifications).values({
            id,
            lead_id: leadId,
            verification_type: type,
            applicant: 'primary',
            submitted_at: now,
            created_at: now,
            updated_at: now,
            ...values,
        });
        return id;
    }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;
        const { couponCode, pan_number, account_number, ifsc, account_holder_name } = await req.json();

        const lead = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
        if (!lead.length) {
            return NextResponse.json({ success: false, error: { message: 'Lead not found' } }, { status: 404 });
        }

        // Server-side precondition gate: dealer must have submitted consent
        // for admin verification AND uploaded all required documents AND
        // reserved a coupon. The client also blocks the button, but we recheck
        // here so a forged request can't bypass it.
        const consentRows = await db
            .select({ status: consentRecords.consent_status })
            .from(consentRecords)
            .where(eq(consentRecords.lead_id, leadId))
            .limit(1);
        const consentStatusVal = (consentRows[0]?.status || lead[0].consent_status || '').toLowerCase();
        const consentSubmitted =
            ['admin_review_pending', 'admin_verified', 'manual_verified', 'verified'].includes(consentStatusVal);

        const docRows = await db
            .select({ doc_type: kycDocuments.doc_type, file_url: kycDocuments.file_url })
            .from(kycDocuments)
            .where(eq(kycDocuments.lead_id, leadId));
        const uploadedTypes = new Set(
            docRows.filter((d) => d.file_url).map((d) => d.doc_type),
        );

        const assetModelStr = String(lead[0].asset_model || '').toUpperCase();
        const isVehicleAsset = ['2W', '3W', '4W'].includes(assetModelStr);
        // Required core docs for a finance lead. RC is conditional on vehicle.
        const requiredDocTypes = ['aadhaar', 'pan', 'photo', ...(isVehicleAsset ? ['rc_copy'] : [])];
        const docsAllUploaded = requiredDocTypes.every((t) => uploadedTypes.has(t));

        const couponReserved = (lead[0].coupon_status || '').toLowerCase() === 'reserved';

        if (!consentSubmitted || !docsAllUploaded || !couponReserved) {
            const missing: string[] = [];
            if (!consentSubmitted) missing.push('consent must be submitted for admin verification');
            if (!docsAllUploaded) missing.push('all required documents must be uploaded');
            if (!couponReserved) missing.push('coupon must be validated');
            return NextResponse.json(
                {
                    success: false,
                    error: { message: `Cannot submit yet — ${missing.join('; ')}` },
                },
                { status: 409 },
            );
        }

        // Resolve the coupon attached to this lead (either passed in the body or already reserved on the lead)
        const activeCouponCode = (couponCode || lead[0].coupon_code || '').toString().toUpperCase().trim();

        // Mark coupon as used in the coupons table (skip for the hardcoded free coupon)
        if (activeCouponCode && activeCouponCode !== 'ITARANG-FREE') {
            await db.update(couponCodes)
                .set({ status: 'used', used_by_lead_id: leadId, used_at: new Date() })
                .where(and(eq(couponCodes.code, activeCouponCode), eq(couponCodes.status, 'reserved')));
        }

        // Persist coupon_status = 'used' on the lead so the UI stays on the "submitted" view across reloads
        if (activeCouponCode) {
            await db.update(leads)
                .set({ coupon_status: 'used', updated_at: new Date() })
                .where(eq(leads.id, leadId));
        }

        const vehicleSlugs = ['2w', '3w', '4w', 'commercial'];
        const assetModel = (lead[0].asset_model || '').toLowerCase();
        const isVehicle = vehicleSlugs.some(s => assetModel.startsWith(s));
        const now = new Date();

        // ── 1. PAN Verification (auto if pan_number provided) ──────────────
        if (pan_number) {
            try {
                const panRes = await validateDocument({
                    document_type: 'PAN',
                    id_number: pan_number.toUpperCase().trim(),
                });
                const panOk = (panRes.responseStatus || panRes.status || '').toUpperCase() === 'SUCCESS'
                    || panRes.message?.toLowerCase().includes('retrieved successfully');
                await upsertVerification(leadId, 'pan', {
                    status: panOk ? 'success' : 'failed',
                    api_provider: 'decentro',
                    api_request: { pan_number },
                    api_response: panRes,
                    failed_reason: panOk ? null : (panRes.message || 'PAN verification failed'),
                    completed_at: now,
                });
            } catch {
                await upsertVerification(leadId, 'pan', {
                    status: 'failed',
                    api_provider: 'decentro',
                    failed_reason: 'API call failed',
                });
            }
        } else {
            // Mark as initiating — dealer must verify manually
            await upsertVerification(leadId, 'pan', {
                status: 'initiating',
                api_provider: 'decentro',
            });
        }

        // ── 2. Bank Account Verification (auto if account details provided) ─
        if (account_number && ifsc) {
            try {
                const bankRes = await verifyBankAccount({
                    account_number,
                    ifsc: ifsc.toUpperCase().trim(),
                    name: account_holder_name,
                    perform_name_match: !!account_holder_name,
                });
                const bankOk = (bankRes.responseStatus || bankRes.status || '').toUpperCase() === 'SUCCESS'
                    || bankRes.message?.toLowerCase().includes('successfully');
                await upsertVerification(leadId, 'bank', {
                    status: bankOk ? 'success' : 'failed',
                    api_provider: 'decentro',
                    api_request: { account_number, ifsc },
                    api_response: bankRes,
                    failed_reason: bankOk ? null : (bankRes.message || 'Bank verification failed'),
                    completed_at: now,
                });
            } catch {
                await upsertVerification(leadId, 'bank', {
                    status: 'failed',
                    api_provider: 'decentro',
                    failed_reason: 'API call failed',
                });
            }
        } else {
            await upsertVerification(leadId, 'bank', {
                status: 'initiating',
                api_provider: 'decentro',
            });
        }

        // ── 3. Aadhaar — mark for OTP flow (dealer does this separately) ───
        await upsertVerification(leadId, 'aadhaar', {
            status: 'initiating',
            api_provider: 'decentro',
        });

        // ── 4. Other checks (address, rc) — mark initiating ────────────────
        const otherTypes = ['address', ...(isVehicle ? ['rc'] : [])];
        for (const type of otherTypes) {
            await upsertVerification(leadId, type, {
                status: 'initiating',
                api_provider: type === 'rc' ? 'surepass' : 'decentro',
            });
        }

        // Update lead KYC status
        await db.update(leads)
            .set({ kyc_status: 'in_progress', updated_at: now })
            .where(eq(leads.id, leadId));

        // Add the lead to the admin verification queue so it surfaces on the
        // admin KYC review page. Idempotent — re-submitting reuses the open
        // entry instead of inserting duplicates.
        const existingQueueEntry = await getOpenQueueEntryForLead(leadId);
        if (!existingQueueEntry) {
            await db.insert(adminVerificationQueue).values({
                id: createWorkflowId('ADMQ', now),
                queue_type: 'kyc_verification',
                lead_id: leadId,
                priority: 'normal',
                assigned_to: null,
                submitted_by: null,
                status: 'pending_itarang_verification',
                submitted_at: now,
                created_at: now,
                updated_at: now,
            });
        }

        // Return current verification state
        const allVers = await db.select().from(kycVerifications).where(eq(kycVerifications.lead_id, leadId));
        const verifications = allVers.map(v => ({
            type: v.verification_type,
            label: VERIFICATION_LABELS[v.verification_type] || v.verification_type,
            status: v.status,
            last_update: v.updated_at?.toISOString() || null,
            failed_reason: v.failed_reason,
        }));

        return NextResponse.json({
            success: true,
            verificationsInitiated: allVers.length,
            estimatedTime: '1-3 minutes for pending checks',
            verifications,
        });
    } catch (error) {
        console.error('Submit verification error:', error);
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
