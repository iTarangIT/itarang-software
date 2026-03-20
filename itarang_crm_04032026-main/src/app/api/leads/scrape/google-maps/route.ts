import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { processLeadScrape } from '@/lib/services/lead-scrape-processor';
import { z } from 'zod';

const scrapeSchema = z.object({
    query: z.string().min(3, 'Search query must be at least 3 characters'),
    city: z.string().optional(),
    state: z.string().optional(),
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['ceo', 'sales_head']);

    const body = await req.json();
    const result = scrapeSchema.safeParse(body);
    if (!result.success) {
        return errorResponse(`Validation Error: ${result.error.issues[0].message}`, 400);
    }

    const { query, city, state } = result.data;

    const scrapeResult = await processLeadScrape({
        query,
        city,
        state,
        userId: user.id,
    });

    return successResponse(scrapeResult, 201);
});
