/**
 * PATCH /api/scraper/leads/[id]/status
 *
 * Sales Manager updates exploration status of a lead assigned to them.
 * Sales Head / CEO / Business Head can update any lead's status.
 */

import { db } from '@/lib/db';
import { scrapedDealerLeads, auditLogs } from '@/lib/db/schema';
import { generateId, withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const statusSchema = z.object({
    exploration_status: z.enum([
        'assigned',
        'exploring',
        'explored',
        'not_interested',
    ]),
    exploration_notes: z.string().max(2000).optional(),
});

export const PATCH = withErrorHandler(
    async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
        const user = await requireRole([
            'sales_manager',
            'sales_head',
            'ceo',
            'business_head',
        ]);
        const { id: leadId } = await params;

        const body = await req.json();
        const result = statusSchema.safeParse(body);
        if (!result.success) {
            return errorResponse(result.error.issues[0].message, 400);
        }
        const { exploration_status, exploration_notes } = result.data;

        // Fetch the lead
        const [lead] = await db
            .select({
                id: scrapedDealerLeads.id,
                dealer_name: scrapedDealerLeads.dealer_name,
                assigned_to: scrapedDealerLeads.assigned_to,
                exploration_status: scrapedDealerLeads.exploration_status,
            })
            .from(scrapedDealerLeads)
            .where(eq(scrapedDealerLeads.id, leadId))
            .limit(1);

        if (!lead) return errorResponse('Lead not found', 404);

        // Sales Manager can only update leads assigned to them
        if (
            user.role === 'sales_manager' &&
            lead.assigned_to !== user.id
        ) {
            return errorResponse('You can only update leads assigned to you', 403);
        }

        const updatePayload: Record<string, unknown> = {
            exploration_status,
            updated_at: new Date(),
        };
        if (exploration_notes !== undefined) {
            updatePayload.exploration_notes = exploration_notes;
        }
        if (
            exploration_status === 'explored' ||
            exploration_status === 'not_interested'
        ) {
            updatePayload.explored_at = new Date();
        }

        await db
            .update(scrapedDealerLeads)
            .set(updatePayload)
            .where(eq(scrapedDealerLeads.id, leadId));

        // Audit log
        await db.insert(auditLogs).values({
            id: await generateId('AUDIT', auditLogs),
            entity_type: 'scraped_lead',
            entity_id: leadId,
            action: 'status_update',
            changes: {
                dealer_name: lead.dealer_name,
                old_status: lead.exploration_status,
                new_status: exploration_status,
                notes: exploration_notes,
            },
            performed_by: user.id,
            timestamp: new Date(),
        });

        return successResponse({ message: 'Status updated', exploration_status });
    }
);
