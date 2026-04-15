import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { kycVerifications, kycDocuments, leads, couponCodes } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { validateDocument, verifyBankAccount } from '@/lib/decentro';
import { logCouponAction } from '@/lib/coupon-audit';

const VERIFICATION_LABELS: Record<string, string> = {
    aadhaar: 'Aadhaar Verification',
    pan: 'PAN Verification',
    bank: 'Bank Verification',
    address: 'Address Proof',
    rc: 'RC Verification',
    mobile: 'Mobile Number',
};

async function upsertVerification(leadId: string, type: string, values: Record<string, unknown>, verificationFor = 'customer') {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');

    const existing = await db.select({ id: kycVerifications.id })
        .from(kycVerifications)
        .where(and(
            eq(kycVerifications.lead_id, leadId),
            eq(kycVerifications.verification_type, type),
            eq(kycVerifications.verification_for, verificationFor),
        ))
        .limit(1);

    if (existing.length > 0) {
        await db.update(kycVerifications).set({ ...values, updated_at: now })
            .where(and(
                eq(kycVerifications.lead_id, leadId),
                eq(kycVerifications.verification_type, type),
                eq(kycVerifications.verification_for, verificationFor),
            ));
        return existing[0].id;
    } else {
        const id = `KYCVER-${dateStr}-${seq}`;
        await db.insert(kycVerifications).values({
            id,
            lead_id: leadId,
            verification_type: type,
            verification_for: verificationFor,
            submitted_at: now,
            created_at: now,
            updated_at: now,
            ...values,
        });
        return id;
    }
}

import { requireRole } from '@/lib/auth-utils';

type RouteContext = {
    params: Promise<{ leadId: string }>;
};

export async function POST(req: NextRequest, context: RouteContext) {
    try {
        const user = await requireRole(['dealer']);
        const { leadId } = await context.params;
        const { pan_number, account_number, ifsc, account_holder_name, verification_for: verForParam } = await req.json();
        const verificationFor = String(verForParam || 'customer').toLowerCase();

        const lead = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
        if (!lead.length) {
            return NextResponse.json({ success: false, error: { message: 'Lead not found' } }, { status: 404 });
        }

        // Require reserved coupon before submission
        const leadCouponCode = lead[0].coupon_code;
        const leadCouponStatus = lead[0].coupon_status;

        if (!leadCouponCode || leadCouponStatus !== 'reserved') {
            return NextResponse.json({
                success: false,
                error: { message: 'A coupon must be validated and reserved before submitting for verification.' },
            }, { status: 400 });
        }

        const HARDCODED_COUPON = 'ITARANG-FREE';
        const isHardcodedCoupon = leadCouponCode === HARDCODED_COUPON;

        if (isHardcodedCoupon) {
            // Hardcoded coupon — just mark lead as used, no DB coupon row to update
            await db.update(leads)
                .set({ coupon_status: 'used', updated_at: new Date() })
                .where(eq(leads.id, leadId));
        } else {
            // Consume coupon: reserved → used
            const reservedCoupons = await db.select({ id: couponCodes.id })
                .from(couponCodes)
                .where(and(eq(couponCodes.code, leadCouponCode), eq(couponCodes.status, 'reserved')))
                .limit(1);

            await db.update(couponCodes)
                .set({ status: 'used', used_by_lead_id: leadId, used_by: user.id, used_at: new Date() })
                .where(and(eq(couponCodes.code, leadCouponCode), eq(couponCodes.status, 'reserved')));

            // Update lead coupon status
            await db.update(leads)
                .set({ coupon_status: 'used', updated_at: new Date() })
                .where(eq(leads.id, leadId));

            // Audit log
            if (reservedCoupons.length) {
                await logCouponAction({
                    couponId: reservedCoupons[0].id,
                    action: 'used',
                    oldStatus: 'reserved',
                    newStatus: 'used',
                    leadId,
                    performedBy: user.id,
                    notes: `Consumed for verification of Lead #${leadId}`,
                });
            }
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
                }, verificationFor);
            } catch {
                await upsertVerification(leadId, 'pan', {
                    status: 'failed',
                    api_provider: 'decentro',
                    failed_reason: 'API call failed',
                }, verificationFor);
            }
        } else {
            // No PAN provided — mark as pending until data is submitted
            await upsertVerification(leadId, 'pan', {
                status: 'pending',
                api_provider: 'decentro',
            }, verificationFor);
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
                }, verificationFor);
            } catch {
                await upsertVerification(leadId, 'bank', {
                    status: 'failed',
                    api_provider: 'decentro',
                    failed_reason: 'API call failed',
                }, verificationFor);
            }
        } else {
            // No bank details provided — mark as pending until data is submitted
            await upsertVerification(leadId, 'bank', {
                status: 'pending',
                api_provider: 'decentro',
            }, verificationFor);
        }

        // ── 3. Aadhaar — pending until dealer starts the OTP flow ──────────
        await upsertVerification(leadId, 'aadhaar', {
            status: 'pending',
            api_provider: 'decentro',
        }, verificationFor);

        // ── 4. Other checks (address, mobile, rc) — pending until initiated ─
        const otherTypes = ['address', 'mobile', ...(isVehicle ? ['rc'] : [])];
        for (const type of otherTypes) {
            await upsertVerification(leadId, type, {
                status: 'pending',
                api_provider: type === 'rc' ? 'surepass' : 'decentro',
            }, verificationFor);
        }

        // Update lead KYC status
        await db.update(leads)
            .set({ kyc_status: 'in_progress', updated_at: now })
            .where(eq(leads.id, leadId));

        // Return current verification state
        const allVers = await db.select().from(kycVerifications).where(and(eq(kycVerifications.lead_id, leadId), eq(kycVerifications.verification_for, verificationFor)));
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
