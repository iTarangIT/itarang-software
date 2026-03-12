/**
 * POST /api/scraper/leads/[id]/assign
 *
 * Assigns a scraped dealer lead to a Sales Manager for exploration.
 * Only Sales Head / CEO / Business Head can call this.
 */

import { db } from '@/lib/db';
import { scrapedDealerLeads, auditLogs, users } from '@/lib/db/schema';
import { generateId, withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const assignSchema = z.object({
    assigned_to: z.string().uuid('assigned_to must be a valid user UUID'),
});

export const POST = withErrorHandler(
    async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(['sales_head', 'ceo', 'business_head']);
        const { id: leadId } = await params;

        const body = await req.json();
        const result = assignSchema.safeParse(body);
        if (!result.success) {
            return errorResponse(result.error.issues[0].message, 400);
        }
        const { assigned_to } = result.data;

        // Verify the lead exists
        const [lead] = await db
            .select({ id: scrapedDealerLeads.id, dealer_name: scrapedDealerLeads.dealer_name })
            .from(scrapedDealerLeads)
            .where(eq(scrapedDealerLeads.id, leadId))
            .limit(1);

        if (!lead) return errorResponse('Lead not found', 404);

        // Verify the target user is a sales_manager
        const [targetUser] = await db
            .select({ id: users.id, name: users.name, role: users.role })
            .from(users)
            .where(eq(users.id, assigned_to))
            .limit(1);

        if (!targetUser) return errorResponse('Assignee user not found', 404);
        if (!['sales_manager', 'sales_head', 'ceo', 'business_head'].includes(targetUser.role)) {
            return errorResponse('Can only assign to Sales Manager or above', 400);
        }

        // Update lead
        await db
            .update(scrapedDealerLeads)
            .set({
                assigned_to,
                assigned_by: user.id,
                assigned_at: new Date(),
                exploration_status: 'assigned',
                updated_at: new Date(),
            })
            .where(eq(scrapedDealerLeads.id, leadId));

        // Audit log
        await db.insert(auditLogs).values({
            id: await generateId('AUDIT', auditLogs),
            entity_type: 'scraped_lead',
            entity_id: leadId,
            action: 'assign',
            changes: {
                assigned_to,
                assigned_to_name: targetUser.name,
                dealer_name: lead.dealer_name,
            },
            performed_by: user.id,
            timestamp: new Date(),
        });

        return successResponse({
            message: `Lead assigned to ${targetUser.name}`,
            assigned_to_name: targetUser.name,
        });
    }
);
