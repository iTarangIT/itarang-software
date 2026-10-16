import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { leads, auditLogs } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import {
    buildDealerEditLockMessage,
    isDealerKycEditsLocked,
} from '@/lib/kyc/admin-workflow';
import { requireRole } from '@/lib/auth-utils';
import { requireLeadAccess } from '@/lib/auth/requireLeadAccess';
import { requireLeadWriter } from '@/lib/leads/actForDealerGuard';
import { restoreMaskedAadhaarDeep } from '@/lib/kyc/aadhaarMask';
import { restoreMaskedPanDeep } from '@/lib/kyc/panMask';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const user = await requireRole(['dealer']);
        const { leadId } = await params;

        if (await isDealerKycEditsLocked(leadId)) {
            return NextResponse.json(
                { success: false, error: { message: buildDealerEditLockMessage() } },
                { status: 409 }
            );
        }

        const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
        if (!lead) {
            return NextResponse.json({ success: false, error: { message: 'Lead not found' } }, { status: 404 });
        }

        // ID 119: the one ownership rule (uploader, or the dealership — falling
        // back to the onboarding dealer code for a login with no dealer_id).
        const access = await requireLeadAccess(leadId);
        if (!access.ok) return access.response;
        // ID 183: the file's own dealer — stamps the dealer's action (the
        // 1-working-day idle rule) and clears any iTarang note. The house login
        // only sees a file it pushed to another dealer.
        const writer = await requireLeadWriter(leadId, req, access.user, { lead: { id: lead.id, dealer_id: lead.dealer_id } });
        if (!writer.ok) return writer.response;

        const { step, data: rawData } = await req.json();
        // ID 119: borrower-details hands the form a masked Aadhaar and the form
        // autosaves it straight back — keep the stored number, not the mask.
        // Same for a PAN masked for a role that may not see it (ID 119 / 166).
        const data = restoreMaskedPanDeep(restoreMaskedAadhaarDeep(rawData, lead.kyc_draft_data), lead.kyc_draft_data);

        const savedAt = new Date();
        await db.update(leads)
            .set({
                kyc_draft_data: data,
                kyc_status: 'draft',
                workflow_step: step || 2,
                updated_at: savedAt,
            })
            .where(eq(leads.id, leadId));

        try {
            await db.insert(auditLogs).values({
                id: `AUDIT-${Date.now()}`,
                entity_type: 'kyc_draft',
                entity_id: leadId,
                action: 'draft_saved',
                changes: { step: step || 2, progress: data?.progress ?? null },
                performed_by: user.id,
                timestamp: savedAt,
            });
        } catch (auditErr) {
            console.error('[KYC Save Draft] Audit insert failed:', auditErr);
        }

        return NextResponse.json({
            success: true,
            savedAt: savedAt.toISOString(),
            progress: data?.progress ?? null,
        });
    } catch (error) {
        console.error('[KYC Save Draft] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        const status = message.startsWith('Forbidden') ? 403 : 500;
        return NextResponse.json({ success: false, error: { message } }, { status });
    }
}
