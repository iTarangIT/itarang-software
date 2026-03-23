import { db } from '@/lib/db';
import { leads, auditLogs } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse, generateId } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

/**
 * Manually qualify a lead.
 * POST /api/leads/[id]/qualify
 */
export const POST = withErrorHandler(async (
    req: Request,
    { params }: { params: { id: string } }
) => {
    // 1. Authorization
    const user = await requireRole(['sales_manager', 'sales_head', 'business_head', 'ceo']);
    const leadId = params.id;
    const { notes } = await req.json();

    // 2. Fetch Lead
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) {
        return errorResponse('Lead not found', 404);
    }

    // 3. Business Rule Validation
    // SOP Rule: Cannot qualify if interest_level = 'cold'
    if (lead.interest_level === 'cold') {
        return errorResponse('Cannot qualify a lead with "Cold" interest level. Please update interest level first.', 400);
    }

    // 4. Update Lead to Qualified
    await db.update(leads)
        .set({
            lead_status: 'qualified',
            qualified_by: user.id,
            qualified_at: new Date(),
            qualification_notes: notes || 'Lead qualified manually.',
            updated_at: new Date(),
        })
        .where(eq(leads.id, leadId));

    // 5. Create Audit Log
    await db.insert(auditLogs).values({
        id: await generateId('AUDIT', auditLogs),
        entity_type: 'lead',
        entity_id: leadId,
        action: 'complete',
        changes: { lead_status: 'qualified', qualification_notes: notes },
        performed_by: user.id,
        timestamp: new Date(),
    });

    return successResponse({
        message: 'Lead qualified successfully',
        lead_id: leadId,
        status: 'qualified'
    });
});
