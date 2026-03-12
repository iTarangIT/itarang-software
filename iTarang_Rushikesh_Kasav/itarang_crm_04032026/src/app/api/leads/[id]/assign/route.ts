import { db } from '@/lib/db';
import { leads, leadAssignments, assignmentChangeLogs, slas } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse, generateId } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { z } from 'zod';
import { triggerN8nWebhook } from '@/lib/n8n';

const assignSchema = z.object({
    lead_owner: z.string().uuid().optional(),
    lead_actor: z.string().uuid().optional(),
});

export const POST = withErrorHandler(async (req: Request, { params }: { params: { id: string } }) => {
    const user = await requireRole(['sales_head', 'business_head', 'ceo', 'sales_manager']);

    const leadId = params.id;
    const body = await req.json();
    const result = assignSchema.safeParse(body);
    if (!result.success) return errorResponse('Validation Error', 400);
    const { lead_owner, lead_actor } = result.data;

    // Fetch existing assignment
    const [currentMsg] = await db.select().from(leadAssignments).where(eq(leadAssignments.lead_id, leadId)).limit(1);

    // 1. Assigning Owner
    if (lead_owner) {
        if (!['sales_head', 'business_head', 'ceo'].includes(user.role)) {
            return errorResponse('Only Sales Head can assign Lead Owner', 403);
        }

        if (currentMsg) {
            await db.update(leadAssignments).set({
                lead_owner,
                assigned_by: user.id,
                updated_at: new Date()
            }).where(eq(leadAssignments.lead_id, leadId));
        } else {
            await db.insert(leadAssignments).values({
                id: await generateId('LASSIGN', leadAssignments),
                lead_id: leadId,
                lead_owner,
                assigned_by: user.id,
                // assigned_at defaults to now
            });
        }

        // Audit Change
        await db.insert(assignmentChangeLogs).values({
            id: await generateId('LOG', assignmentChangeLogs),
            lead_id: leadId,
            change_type: currentMsg ? 'owner_changed' : 'owner_assigned',
            old_user_id: currentMsg?.lead_owner,
            new_user_id: lead_owner,
            changed_by: user.id,
            changed_at: new Date()
        });

        // Trigger Notification
        await triggerN8nWebhook('lead-assigned', {
            lead_id: leadId,
            assigned_user_id: lead_owner,
            assignment_type: 'owner',
            assigned_by: user.id
        });

        // Complete SLA (SOP 11.1)
        await db.update(slas)
            .set({
                status: 'completed',
                completed_at: new Date()
            })
            .where(and(
                eq(slas.entity_id, leadId),
                eq(slas.workflow_step, 'lead_first_call'),
                eq(slas.status, 'active')
            ));
    }

    // 2. Assigning Actor
    if (lead_actor) {
        // Check permission: Must be Sales Head OR Current Owner
        const isOwner = currentMsg?.lead_owner === user.id;
        const isSalesHead = ['sales_head', 'business_head', 'ceo'].includes(user.role);

        if (!isOwner && !isSalesHead) {
            return errorResponse('Only Lead Owner or Sales Head can assign Lead Actor', 403);
        }

        if (currentMsg) {
            await db.update(leadAssignments).set({
                lead_actor,
                actor_assigned_by: user.id,
                actor_assigned_at: new Date(),
                updated_at: new Date()
            }).where(eq(leadAssignments.lead_id, leadId));
        } else {
            return errorResponse('Assign Lead Owner first', 400);
        }

        // Audit Change
        await db.insert(assignmentChangeLogs).values({
            id: await generateId('LOG', assignmentChangeLogs),
            lead_id: leadId,
            change_type: currentMsg?.lead_actor ? 'actor_changed' : 'actor_assigned',
            old_user_id: currentMsg?.lead_actor,
            new_user_id: lead_actor,
            changed_by: user.id,
            changed_at: new Date()
        });

        // Trigger Notification
        await triggerN8nWebhook('lead-assigned', {
            lead_id: leadId,
            assigned_user_id: lead_actor,
            assignment_type: 'actor',
            assigned_by: user.id
        });
    }

    return successResponse({ message: 'Assignment updated' });
});
