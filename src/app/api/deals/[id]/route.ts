import { db } from '@/lib/db';
import { deals, approvals, leads, auditLogs } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { z } from 'zod';

export const GET = withErrorHandler(async (req: Request, { params }: { params: { id: string } }) => {
    const user = await requireRole(['sales_manager', 'sales_head', 'business_head', 'ceo', 'finance_controller']);
    const dealId = params.id;

    // Fetch Deal
    const [deal] = await db.select().from(deals).where(eq(deals.id, dealId)).limit(1);
    if (!deal) return errorResponse('Deal not found', 404);

    // Fetch Lead info
    const [lead] = await db.select().from(leads).where(eq(leads.id, deal.lead_id)).limit(1);

    // Fetch Approval History
    const approvalHistory = await db.select()
        .from(approvals)
        .where(and(eq(approvals.entity_type, 'deal'), eq(approvals.entity_id, dealId)))
        .orderBy(approvals.level);

    return successResponse({
        deal,
        lead,
        approvals: approvalHistory,
    });
});

const updateDealSchema = z.object({
    transportation_cost: z.number().nonnegative().optional(),
    payment_term: z.enum(['cash', 'credit']).optional(),
    credit_period_months: z.number().positive().optional(),
});

export const PATCH = withErrorHandler(async (req: Request, { params }: { params: { id: string } }) => {
    const user = await requireRole(['sales_manager', 'sales_head', 'business_head', 'ceo']);
    const dealId = params.id;
    const body = await req.json();

    const result = updateDealSchema.safeParse(body);
    if (!result.success) return errorResponse('Validation Error', 400);
    const data = result.data;

    // Fetch Deal
    const [deal] = await db.select().from(deals).where(eq(deals.id, dealId)).limit(1);
    if (!deal) return errorResponse('Deal not found', 404);

    // Check immutability
    if (deal.is_immutable) {
        return errorResponse('Cannot update: Deal is immutable (invoice issued)', 403);
    }

    // Recalculate total if transportation changed
    let updates: any = { ...data, updated_at: new Date() };
    if (data.transportation_cost !== undefined) {
        const transportWithGst = data.transportation_cost * (1 + (deal.transportation_gst_percent || 18) / 100);
        updates.total_payable = deal.line_total + deal.gst_amount + transportWithGst;
    }

    await db.update(deals).set(updates).where(eq(deals.id, dealId));

    // Audit Log
    await db.insert(auditLogs).values({
        id: await generateId('AUDIT', auditLogs),
        entity_type: 'deal',
        entity_id: dealId,
        action: 'update',
        changes: updates,
        performed_by: user.id,
        timestamp: new Date(),
    });

    return successResponse({ message: 'Deal updated successfully' });
});
