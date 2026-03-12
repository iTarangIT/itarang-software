import { db } from '@/lib/db';
import { scraperSearchQueries, users } from '@/lib/db/schema';
import { generateId, withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';

const createSchema = z.object({
    query_text: z.string().min(3).max(500),
});

export const GET = withErrorHandler(async () => {
    await requireRole(['sales_head', 'ceo', 'business_head']);

    const rows = await db
        .select({
            id: scraperSearchQueries.id,
            query_text: scraperSearchQueries.query_text,
            is_active: scraperSearchQueries.is_active,
            created_by_name: users.name,
            created_at: scraperSearchQueries.created_at,
        })
        .from(scraperSearchQueries)
        .leftJoin(users, eq(scraperSearchQueries.created_by, users.id))
        .orderBy(desc(scraperSearchQueries.created_at));

    return successResponse(rows);
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['sales_head', 'ceo', 'business_head']);

    const body = await req.json();
    const result = createSchema.safeParse(body);
    if (!result.success) return errorResponse(result.error.issues[0].message, 400);

    const id = await generateId('SQ', scraperSearchQueries);
    await db.insert(scraperSearchQueries).values({
        id,
        query_text: result.data.query_text.trim(),
        created_by: user.id,
    });

    return successResponse({ id, message: 'Query added' }, 201);
});
