import { db } from '@/lib/db';
import { scraperSearchQueries } from '@/lib/db/schema';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const updateSchema = z.object({
    query_text: z.string().min(3).max(500).optional(),
    is_active: z.boolean().optional(),
});

export const PATCH = withErrorHandler(
    async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
        await requireRole(['sales_head', 'ceo', 'business_head']);
        const { id } = await params;

        const body = await req.json();
        const result = updateSchema.safeParse(body);
        if (!result.success) return errorResponse(result.error.issues[0].message, 400);

        const updates: Record<string, unknown> = { updated_at: new Date() };
        if (result.data.query_text !== undefined) updates.query_text = result.data.query_text.trim();
        if (result.data.is_active !== undefined) updates.is_active = result.data.is_active;

        const [updated] = await db
            .update(scraperSearchQueries)
            .set(updates)
            .where(eq(scraperSearchQueries.id, id))
            .returning({ id: scraperSearchQueries.id });

        if (!updated) return errorResponse('Query not found', 404);
        return successResponse({ message: 'Query updated' });
    }
);

export const DELETE = withErrorHandler(
    async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
        await requireRole(['sales_head', 'ceo', 'business_head']);
        const { id } = await params;

        const [deleted] = await db
            .delete(scraperSearchQueries)
            .where(eq(scraperSearchQueries.id, id))
            .returning({ id: scraperSearchQueries.id });

        if (!deleted) return errorResponse('Query not found', 404);
        return successResponse({ message: 'Query deleted' });
    }
);
