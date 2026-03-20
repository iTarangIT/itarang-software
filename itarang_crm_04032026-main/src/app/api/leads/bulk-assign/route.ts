import { db } from '@/lib/db';
import { leads, leadAssignments, assignmentChangeLogs, slas } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse, generateId } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { triggerN8nWebhook } from '@/lib/n8n';
import { z } from 'zod';

const bulkAssignSchema = z.object({
    leadIds: z.array(z.string()).min(1, 'At least one lead required').max(100),
    lead_owner: z.string().uuid('Invalid user ID'),
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['ceo', 'sales_head']);
    const body = await req.json();

    const result = bulkAssignSchema.safeParse(body);
    if (!result.success) {
        return errorResponse(`Validation Error: ${result.error.issues[0].message}`, 400);
    }

    const { leadIds, lead_owner } = result.data;
    let assigned = 0;
    const errors: { leadId: string; error: string }[] = [];

    for (const leadId of leadIds) {
        try {
            // Check if assignment exists
            const [existing] = await db.select()
                .from(leadAssignments)
                .where(eq(leadAssignments.lead_id, leadId))
                .limit(1);

            if (existing) {
                // Update existing assignment
                await db.update(leadAssignments).set({
                    lead_owner,
                    assigned_by: user.id,
                    updated_at: new Date(),
                }).where(eq(leadAssignments.lead_id, leadId));
            } else {
                // Create new assignment
                await db.insert(leadAssignments).values({
                    id: await generateId('LASSIGN', leadAssignments),
                    lead_id: leadId,
                    lead_owner,
                    assigned_by: user.id,
                });
            }

            // Audit log
            await db.insert(assignmentChangeLogs).values({
                id: await generateId('LOG', assignmentChangeLogs),
                lead_id: leadId,
                change_type: existing ? 'owner_changed' : 'owner_assigned',
                old_user_id: existing?.lead_owner || null,
                new_user_id: lead_owner,
                changed_by: user.id,
                changed_at: new Date(),
            });

            // Update lead status to assigned
            await db.update(leads).set({
                lead_status: 'assigned',
                updated_at: new Date(),
            }).where(eq(leads.id, leadId));

            // Complete SLA if active
            await db.update(slas).set({
                status: 'completed',
                completed_at: new Date(),
            }).where(and(
                eq(slas.entity_id, leadId),
                eq(slas.workflow_step, 'lead_first_call'),
                eq(slas.status, 'active'),
            ));

            // Notify via n8n
            triggerN8nWebhook('lead-assigned', {
                lead_id: leadId,
                assigned_user_id: lead_owner,
                assignment_type: 'owner',
                assigned_by: user.id,
                bulk: true,
            }).catch(() => {}); // Fire and forget

            assigned++;
        } catch (err) {
            errors.push({ leadId, error: err instanceof Error ? err.message : 'Unknown error' });
        }
    }

    return successResponse({ assigned, total: leadIds.length, errors });
});
