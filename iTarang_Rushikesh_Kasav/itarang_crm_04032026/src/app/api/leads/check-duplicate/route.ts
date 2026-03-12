import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { successResponse, errorResponse, withErrorHandler } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { eq, or, and } from 'drizzle-orm';

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['dealer']);

    const { searchParams } = new URL(req.url);
    const phone = searchParams.get('phone');

    if (!phone) {
        return errorResponse('Phone number required', 400);
    }

    // Normalize for lookup
    let clean = phone.replace(/[^0-9]/g, '');
    if (clean.length === 12 && clean.startsWith('91')) clean = clean.substring(2);
    if (clean.length === 10) clean = `+91${clean}`;
    else if (!clean.startsWith('+')) clean = `+91${clean}`;

    // Scope to current dealer as per standard CRM rules
    const matches = await db.select({
        id: leads.id,
        owner_name: leads.owner_name,
        phone: leads.phone,
        status: leads.status
    }).from(leads).where(
        and(
            eq(leads.dealer_id, user.dealer_id!),
            or(
                eq(leads.phone, clean),
                eq(leads.owner_contact, clean),
                eq(leads.mobile, clean)
            )
        )
    ).limit(5);

    return successResponse(matches);
});
