import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { db } from '@/lib/db';
import { leads, auditLogs } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';
import { dealerMayActOnLead } from '@/lib/auth/requireLeadAccess';

export const DELETE = withErrorHandler(async (_req: Request, { params }: { params: Promise<{ leadId: string }> }) => {
    const user = await requireRole(['dealer']);
    const { leadId } = await params;

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) return errorResponse('Draft not found', 404);

    const isOwner = lead.uploader_id === user.id;
    // ID 119: resolves a dealer login with no users.dealer_id via its onboarding code.
    const isSameDealer = await dealerMayActOnLead(user, lead.dealer_id, leadId);
    // 16 Oct (ID 183): the creator only while the lead has no dealer — the house
    // login no longer changes a file it pushed to another dealer.
    if (!isSameDealer && !(isOwner && !lead.dealer_id)) {
        return errorResponse('Forbidden: You do not have permission to delete this draft', 403);
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

    return successResponse({ message: 'Draft cleared. Lead retained.' });
});
