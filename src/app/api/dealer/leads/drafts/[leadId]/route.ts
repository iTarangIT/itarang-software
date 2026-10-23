import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { db } from '@/lib/db';
import { leads, auditLogs } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';
// ID 183 (23 Oct): the house login's saves here take the dealer-wins check and the "Done by" record.
import { recordActorStep, requireLeadWriter } from '@/lib/leads/actForDealerGuard';

export const DELETE = withErrorHandler(async (req: Request, { params }: { params: Promise<{ leadId: string }> }) => {
    const user = await requireRole(['dealer']);
    const { leadId } = await params;

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) return errorResponse('Draft not found', 404);

    const isOwner = lead.uploader_id === user.id;
    // The creator while the lead has no dealer; otherwise the file's dealer, or the
    // house login on a file it pushed out (dealer-wins check + "Done by", ID 183).
    let writer: Awaited<ReturnType<typeof requireLeadWriter>> | null = null;
    if (!(isOwner && !lead.dealer_id)) {
        writer = await requireLeadWriter(leadId, req, user, { lead: { id: leadId, dealer_id: lead.dealer_id } });
        if (!writer.ok) return errorResponse('Forbidden: You do not have permission to delete this draft', 403);
    }

    if (lead.kyc_status !== 'draft') {
        return errorResponse('This lead is not in draft state', 400);
    }

    const now = new Date();
    await db.update(leads)
        .set({
            kyc_draft_data: null,
            kyc_status: 'pending',
            workflow_step: 1,
            updated_at: now,
        })
        .where(eq(leads.id, leadId));

    try {
        await db.insert(auditLogs).values({
            id: `AUDIT-${Date.now()}`,
            entity_type: 'kyc_draft',
            entity_id: leadId,
            action: 'draft_deleted',
            changes: { deleted_by: user.id },
            performed_by: user.id,
            timestamp: now,
        });
    } catch (auditErr) {
        console.error('[KYC Draft Delete] Audit insert failed:', auditErr);
    }

    if (writer?.ok) await recordActorStep(writer.actor, 'cleared the draft');

    return successResponse({ message: 'Draft cleared. Lead retained.' });
});
