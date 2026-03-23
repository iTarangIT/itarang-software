import { db } from '@/lib/db';
import { orderDisputes } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

export const GET = withErrorHandler(async (req: Request, { params }: { params: { id: string } }) => {
    const user = await requireRole(['inventory_manager', 'sales_head', 'business_head', 'ceo', 'sales_manager', 'sales_executive', 'service_engineer']);
    const disputeId = params.id;

    const [dispute] = await db.select().from(orderDisputes).where(eq(orderDisputes.id, disputeId)).limit(1);
    if (!dispute) return errorResponse('Dispute not found', 404);

    return successResponse(dispute);
});
