import { db } from '@/lib/db';
import { scraperSchedules } from '@/lib/db/schema';
import { generateId, withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const scheduleSchema = z.object({
    frequency: z.enum(['every_2_days', 'weekly', 'biweekly', 'monthly']),
    day_of_week: z.number().min(0).max(6).optional(),
    time_of_day: z.string().regex(/^\d{2}:\d{2}$/).optional().default('03:00'),
    is_active: z.boolean().optional().default(true),
});

export const GET = withErrorHandler(async () => {
    await requireRole(['sales_head', 'ceo', 'business_head']);

    const [schedule] = await db
        .select()
        .from(scraperSchedules)
        .where(eq(scraperSchedules.is_active, true))
        .limit(1);

    return successResponse(schedule ?? null);
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['sales_head', 'ceo', 'business_head']);

    const body = await req.json();
    const result = scheduleSchema.safeParse(body);
    if (!result.success) return errorResponse(result.error.issues[0].message, 400);

    // Deactivate all existing schedules
    await db.update(scraperSchedules).set({ is_active: false, updated_at: new Date() });

    if (!result.data.is_active) {
        return successResponse({ message: 'Schedule disabled' });
    }

    const id = await generateId('SCHED', scraperSchedules);
    await db.insert(scraperSchedules).values({
        id,
        frequency: result.data.frequency,
        day_of_week: result.data.day_of_week ?? null,
        time_of_day: result.data.time_of_day,
        is_active: true,
        created_by: user.id,
    });

    return successResponse({ id, message: 'Schedule set' }, 201);
});

export const DELETE = withErrorHandler(async () => {
    await requireRole(['sales_head', 'ceo', 'business_head']);

    await db.update(scraperSchedules).set({ is_active: false, updated_at: new Date() });
    return successResponse({ message: 'Schedule disabled' });
});
