import { db } from '@/lib/db';
import { orderDisputes, auditLogs, users } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse, generateId } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { z } from 'zod';

const disputeSchema = z.object({
    order_id: z.string().min(1),
    dispute_type: z.enum(['damage', 'shortage', 'delivery_failure']),
    description: z.string().min(10),
    photos_urls: z.array(z.string()).optional(),
});

export const POST = withErrorHandler(async (req: Request) => {
    // Standard user can create dispute? SOP says "Created by Service Engineer or Sales Executive" usually
    const user = await requireRole(['sales_executive', 'service_engineer', 'sales_manager', 'sales_head', 'ceo']);
    const body = await req.json();

    const result = disputeSchema.safeParse(body);
    if (!result.success) return errorResponse('Validation Error', 400);
    const data = result.data;

    // 1. Determine Auto-Assignment Logic (SOP 9.6)
    let assigned_role = 'sales_head';
    if (data.dispute_type === 'shortage') {
        assigned_role = 'inventory_manager';
    }

    // Find a user with this role
    const [assignedUser] = await db.select().from(users).where(eq(users.role, assigned_role)).limit(1);
    if (!assignedUser) return errorResponse(`No user found with role: ${assigned_role} to assign dispute`, 500);

    const disputeId = await generateId('DISP', orderDisputes);

    await db.insert(orderDisputes).values({
        id: disputeId,
        order_id: data.order_id,
        dispute_type: data.dispute_type,
        description: data.description,
        photos_urls: data.photos_urls as any,
        assigned_to: assignedUser.id,
        resolution_status: 'open',
        created_by: user.id,
        created_at: new Date(),
    });

    // Audit Log
    await db.insert(auditLogs).values({
        id: await generateId('AUDIT', auditLogs),
        entity_type: 'order_dispute',
        entity_id: disputeId,
        action: 'create',
        changes: { ...data, assigned_to: assignedUser.id } as any,
        performed_by: user.id,
        timestamp: new Date(),
    });

    return successResponse({ id: disputeId, message: 'Dispute raised and assigned to ' + assigned_role }, 201);
});

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['inventory_manager', 'sales_head', 'business_head', 'ceo', 'sales_manager']);
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');
    const assignedToMe = searchParams.get('assignedToMe');

    let conditions = [];
    if (status) conditions.push(eq(orderDisputes.resolution_status, status));
    if (assignedToMe === 'true') conditions.push(eq(orderDisputes.assigned_to, user.id));

    const result = await db.select()
        .from(orderDisputes)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(orderDisputes.created_at);

    return successResponse(result);
});
