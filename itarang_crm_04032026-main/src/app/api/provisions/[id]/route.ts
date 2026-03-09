import { z } from 'zod';
import { db } from '@/lib/db';
import { provisions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireRole } from '@/lib/auth-utils';
import { successResponse, withErrorHandler } from '@/lib/api-utils';

const patchSchema = z.object({
    status: z.enum(['acknowledged', 'in_production', 'ready_for_pdi', 'completed', 'cancelled']),
});

export const PATCH = withErrorHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id: provisionId } = await params;
    await requireRole(['inventory_manager', 'ceo', 'business_head']);
    const body = await req.json();
    const { status } = patchSchema.parse(body);

    const [updated] = await db.update(provisions)
        .set({ status, updated_at: new Date() })
        .where(eq(provisions.id, provisionId))
        .returning();

    if (!updated) throw new Error('Provision not found');

    return successResponse(updated);
});
