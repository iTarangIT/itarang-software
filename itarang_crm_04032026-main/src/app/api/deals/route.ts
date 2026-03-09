import { db } from '@/lib/db';
import { deals, leads, approvals, auditLogs, accounts } from '@/lib/db/schema';
import { eq, and, or } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse, generateId } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { checkCreditBlock } from '@/lib/sales-utils';
import { z } from 'zod';

const dealSchema = z.object({
    lead_id: z.string().min(1),
    products: z.array(z.object({
        product_id: z.string(),
        product_name: z.string(),
        quantity: z.number().positive(),
        unit_price: z.number().positive(),
        subtotal: z.number().positive(),
    })),
    line_total: z.number().positive(),
    gst_amount: z.number().nonnegative(),
    transportation_cost: z.number().nonnegative().default(0),
    transportation_gst_percent: z.number().nonnegative().default(18),
    payment_term: z.enum(['cash', 'credit']),
    credit_period_months: z.number().positive().optional(),
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['sales_manager', 'sales_head', 'business_head', 'ceo']);
    const body = await req.json();

    const result = dealSchema.safeParse(body);
    if (!result.success) return errorResponse('Validation Error', 400);
    const data = result.data;

    // 1. Validate Lead exists and is Hot + Qualified
    const [lead] = await db.select().from(leads).where(eq(leads.id, data.lead_id)).limit(1);
    if (!lead) return errorResponse('Lead not found', 404);

    if (lead.interest_level !== 'hot') {
        return errorResponse('Cannot create deal: Lead must have "Hot" interest level', 400);
    }
    if (lead.lead_status !== 'qualified') {
        return errorResponse('Cannot create deal: Lead must be qualified first', 400);
    }

    // 1.5 Check Credit Block for existing account (SOP 3.6)
    const [account] = await db.select()
        .from(accounts)
        .where(eq(accounts.phone, lead.owner_contact))
        .limit(1);

    if (account) {
        const blockStatus = await checkCreditBlock(account.id);
        if (blockStatus.isBlocked) {
            return errorResponse(`Cannot create deal: ${blockStatus.reason}`, 403);
        }
    }

    // 2. Check for active deals
    const activeDeals = await db.select()
        .from(deals)
        .where(
            and(
                eq(deals.lead_id, data.lead_id),
                or(
                    eq(deals.deal_status, 'pending_approval_l1'),
                    eq(deals.deal_status, 'pending_approval_l2'),
                    eq(deals.deal_status, 'pending_approval_l3'),
                    eq(deals.deal_status, 'approved'),
                    eq(deals.deal_status, 'payment_awaited')
                )
            )
        );

    if (activeDeals.length > 0) {
        return errorResponse('Cannot create deal: An active deal already exists for this lead', 400);
    }

    // 3. Validate payment term
    if (data.payment_term === 'credit' && !data.credit_period_months) {
        return errorResponse('Credit period is required for credit payment term', 400);
    }

    // 4. Calculate total_payable
    const transportWithGst = data.transportation_cost * (1 + data.transportation_gst_percent / 100);
    const total_payable = data.line_total + data.gst_amount + transportWithGst;

    // 5. Create Deal
    const dealId = await generateId('DEAL', deals);
    await db.insert(deals).values({
        id: dealId,
        lead_id: data.lead_id,
        products: data.products as any,
        line_total: data.line_total.toString(),
        gst_amount: data.gst_amount.toString(),
        transportation_cost: data.transportation_cost.toString(),
        transportation_gst_percent: data.transportation_gst_percent,
        total_payable: total_payable.toString(),
        payment_term: data.payment_term,
        credit_period_months: data.credit_period_months,
        deal_status: 'pending_approval_l1',
        created_by: user.id,
    });

    // 6. Create L1 Approval (Sales Head)
    const approvalId = await generateId('APPR', approvals);
    await db.insert(approvals).values({
        id: approvalId,
        entity_type: 'deal',
        entity_id: dealId,
        level: 1,
        approver_role: 'sales_head',
        status: 'pending',
        created_at: new Date(),
    });

    // 7. Audit Log
    await db.insert(auditLogs).values({
        id: await generateId('AUDIT', auditLogs),
        entity_type: 'deal',
        entity_id: dealId,
        action: 'create',
        changes: { ...data, total_payable } as any,
        performed_by: user.id,
        timestamp: new Date(),
    });

    return successResponse({
        id: dealId,
        message: 'Deal created successfully',
        total_payable,
        approval_id: approvalId
    }, 201);
});

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['sales_manager', 'sales_head', 'business_head', 'ceo', 'finance_controller']);
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');
    const leadId = searchParams.get('lead_id');

    let conditions = [];
    if (status) conditions.push(eq(deals.deal_status, status));
    if (leadId) conditions.push(eq(deals.lead_id, leadId));

    const result = await db.select()
        .from(deals)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(deals.created_at);

    return successResponse(result);
});
