import { db } from '@/lib/db';
import { leads, personalDetails } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { successResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

export const GET = withErrorHandler(async () => {
    const user = await requireRole(['dealer']);

    const [activeLead] = await db.select()
        .from(leads)
        .where(
            and(
                eq(leads.uploader_id, user.id),
                eq(leads.status, 'INCOMPLETE')
            )
        )
        .limit(1);

    if (!activeLead) {
        return successResponse(null);
    }

    const [details] = await db.select()
        .from(personalDetails)
        .where(eq(personalDetails.lead_id, activeLead.id))
        .limit(1);

    return successResponse({
        ...activeLead,
        personalDetails: details
    });
});
