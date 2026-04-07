import { db } from '@/lib/db';
import { scrapedDealerLeads } from '@/lib/db/schema';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { eq } from 'drizzle-orm';

export const GET = withErrorHandler(
    async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
        await requireRole(['sales_manager', 'sales_head', 'ceo', 'business_head']);
        const { id } = await params;

        const [lead] = await db
            .select()
            .from(scrapedDealerLeads)
            .where(eq(scrapedDealerLeads.id, id))
            .limit(1);

        if (!lead) return errorResponse('Lead not found', 404);
        return successResponse(lead);
    }
);
