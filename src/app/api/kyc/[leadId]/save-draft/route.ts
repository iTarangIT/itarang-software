import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { leads, auditLogs } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import {
    buildDealerEditLockMessage,
    isDealerKycEditsLocked,
} from '@/lib/kyc/admin-workflow';
import { requireRole } from '@/lib/auth-utils';

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

        const isOwner = lead.uploader_id === user.id;
        const isSameDealer = user.dealer_id && lead.dealer_id === user.dealer_id;
        if (!isOwner && !isSameDealer) {
            return NextResponse.json(
                { success: false, error: { message: 'Forbidden: You do not have permission to edit this lead' } },
                { status: 403 }
            );
        }

        const { step, data } = await req.json();

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
