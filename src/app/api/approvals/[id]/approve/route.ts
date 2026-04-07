import { db } from '@/lib/db';
import { approvals, deals, auditLogs, accounts, leads } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse, generateId } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { checkCreditBlock } from '@/lib/sales-utils';
import { z } from 'zod';

const decisionSchema = z.object({
    comments: z.string().optional(),
});

export const POST = withErrorHandler(async (req: Request, { params }: { params: { id: string } }) => {
    const body = await req.json();
    const result = decisionSchema.safeParse(body);
    if (!result.success) return errorResponse('Validation Error', 400);
    const { comments } = result.data;

    const approvalId = params.id;

    // 1. Fetch Approval record
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
    if (!approval) return errorResponse('Approval record not found', 404);
    if (approval.status !== 'pending') return errorResponse('This approval is already processed', 400);

    // 2. Validate Role Permission
    const user = await requireRole([approval.approver_role]);

    // 2.5 Check Credit Block for Deals (SOP 3.6)
    if (approval.entity_type === 'deal') {
        const [deal] = await db.select().from(deals).where(eq(deals.id, approval.entity_id)).limit(1);
        if (deal) {
            const [lead] = await db.select().from(leads).where(eq(leads.id, deal.lead_id)).limit(1);
            if (lead) {
                const [account] = await db.select().from(accounts).where(eq(accounts.phone, lead.owner_contact)).limit(1);
                if (account) {
                    const blockStatus = await checkCreditBlock(account.id);
                    if (blockStatus.isBlocked) {
                        return errorResponse(`Approval blocked: ${blockStatus.reason}`, 403);
                    }
                }
            }
        }
    }

    // 3. Process Approval
    await db.transaction(async (tx) => {
        // Update current approval
        await tx.update(approvals)
            .set({
                status: 'approved',
                approver_id: user.id,
                decision_at: new Date(),
                comments,
            })
            .where(eq(approvals.id, approvalId));

        // Handle Entity State Transition (Specifically for Deal)
        if (approval.entity_type === 'deal') {
            const dealId = approval.entity_id;
            const level = approval.level;

            if (level === 1) {
                // L1 Approved -> Create L2
                const l2Id = await generateId('APPR', approvals);
                await tx.insert(approvals).values({
                    id: l2Id,
                    entity_type: 'deal',
                    entity_id: dealId,
                    level: 2,
                    approver_role: 'business_head',
                    status: 'pending',
                });
                await tx.update(deals).set({ deal_status: 'pending_approval_l2', updated_at: new Date() }).where(eq(deals.id, dealId));
            } else if (level === 2) {
                // L2 Approved -> Create L3
                const l3Id = await generateId('APPR', approvals);
                await tx.insert(approvals).values({
                    id: l3Id,
                    entity_type: 'deal',
                    entity_id: dealId,
                    level: 3,
                    approver_role: 'finance_controller',
                    status: 'pending',
                });
                await tx.update(deals).set({ deal_status: 'pending_approval_l3', updated_at: new Date() }).where(eq(deals.id, dealId));
            } else if (level === 3) {
                // L3 Approved -> Finalize Deal
                await tx.update(deals)
                    .set({
                        deal_status: 'approved', // or 'payment_awaited' depending on SOP nuance. SOP says "Issue invoice"
                        is_immutable: true,
                        invoice_issued_at: new Date(),
                        updated_at: new Date()
                    })
                    .where(eq(deals.id, dealId));
            }
        }

        // Audit Log
        await tx.insert(auditLogs).values({
            id: await generateId('AUDIT', auditLogs),
            entity_type: approval.entity_type,
            entity_id: approval.entity_id,
            action: 'approve',
            changes: { level: approval.level, approver: user.role, comments },
            performed_by: user.id,
            timestamp: new Date(),
        });
    });

    return successResponse({ message: 'Approved successfully' });
});
