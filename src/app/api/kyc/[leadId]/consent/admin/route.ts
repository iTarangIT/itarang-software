export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { leads, consentRecords } from '@/lib/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';

type RouteContext = {
    params: Promise<{ leadId: string }>;
};

/**
 * POST /api/kyc/:leadId/consent/admin
 * Admin approve or reject consent
 *
 * Body: { decision: 'approved' | 'rejected', reviewerNotes?: string, rejectionReason?: string }
 */
export async function POST(req: NextRequest, { params }: RouteContext) {
    try {
        const user = await requireRole(['admin', 'ceo', 'business_head', 'sales_head']);
        const { leadId } = await params;
        const body = await req.json();

        const { decision, reviewerNotes, rejectionReason, consent_for: consentForParam } = body;
        const consentFor = String(consentForParam || 'customer').toLowerCase();
        const dbConsentFor = consentFor === 'customer' ? 'primary' : consentFor;

        if (!decision || !['approved', 'rejected'].includes(decision)) {
            return NextResponse.json(
                { success: false, error: { message: 'decision must be "approved" or "rejected"' } },
                { status: 400 }
            );
        }

        if (decision === 'rejected' && !rejectionReason) {
            return NextResponse.json(
                { success: false, error: { message: 'rejectionReason is required when rejecting' } },
                { status: 400 }
            );
        }

        // Find the latest consent record for this lead
        const consentRows = await db.select()
            .from(consentRecords)
            .where(and(
                eq(consentRecords.lead_id, leadId),
                eq(consentRecords.consent_for, dbConsentFor),
            ))
            .orderBy(desc(consentRecords.updated_at))
            .limit(1);

        if (!consentRows.length) {
            return NextResponse.json(
                { success: false, error: { message: 'No consent record found for this lead' } },
                { status: 404 }
            );
        }

        const consent = consentRows[0];
        const now = new Date();

        if (decision === 'approved') {
            // Determine final status based on consent type
            const finalStatus = consent.consent_type === 'digital' ? 'admin_verified' : 'manual_verified';

            await db.update(consentRecords)
                .set({
                    consent_status: finalStatus,
                    verified_by: user.id,
                    verified_at: now,
                    reviewer_notes: reviewerNotes || null,
                    updated_at: now,
                })
                .where(eq(consentRecords.id, consent.id));

            const approveUpdate = consentFor === 'borrower'
                ? { borrower_consent_status: finalStatus, updated_at: now }
                : { consent_status: finalStatus, updated_at: now };
            await db.update(leads)
                .set(approveUpdate)
                .where(eq(leads.id, leadId));

            return NextResponse.json({
                success: true,
                status: finalStatus,
                message: 'Consent verified successfully.',
            });
        } else {
            // Rejected
            await db.update(consentRecords)
                .set({
                    consent_status: 'admin_rejected',
                    rejected_by: user.id,
                    rejected_at: now,
                    rejection_reason: rejectionReason,
                    reviewer_notes: reviewerNotes || null,
                    updated_at: now,
                })
                .where(eq(consentRecords.id, consent.id));

            const rejectUpdate = consentFor === 'borrower'
                ? { borrower_consent_status: 'admin_rejected', updated_at: now }
                : { consent_status: 'admin_rejected', updated_at: now };
            await db.update(leads)
                .set(rejectUpdate)
                .where(eq(leads.id, leadId));

            return NextResponse.json({
                success: true,
                status: 'admin_rejected',
                message: 'Consent rejected. Dealer will be notified to re-submit.',
            });
        }
    } catch (error) {
        console.error('[Consent Admin Review] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}

/**
 * GET /api/kyc/:leadId/consent/admin
 * Get consent details for admin review
 */
export async function GET(req: NextRequest, { params }: RouteContext) {
    try {
        await requireRole(['admin', 'ceo', 'business_head', 'sales_head']);
        const { leadId } = await params;

        const consentFor = req.nextUrl.searchParams.get('consent_for') || 'customer';
        const dbConsentFor = consentFor === 'customer' ? 'primary' : consentFor;

        const consentRows = await db.select()
            .from(consentRecords)
            .where(and(
                eq(consentRecords.lead_id, leadId),
                eq(consentRecords.consent_for, dbConsentFor),
            ))
            .orderBy(desc(consentRecords.updated_at))
            .limit(1);

        if (!consentRows.length) {
            return NextResponse.json({ success: true, data: null });
        }

        const leadRows = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);

        return NextResponse.json({
            success: true,
            data: {
                consent: consentRows[0],
                lead: leadRows[0] || null,
            },
        });
    } catch (error) {
        console.error('[Consent Admin GET] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
