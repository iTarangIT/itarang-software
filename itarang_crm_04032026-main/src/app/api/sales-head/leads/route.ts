import { db } from '@/lib/db';
import { leads, leadAssignments, users } from '@/lib/db/schema';
import { eq, isNull, and, desc, sql } from 'drizzle-orm';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(['ceo', 'sales_head']);

    const { searchParams } = new URL(req.url);
    const tab = searchParams.get('tab') || 'unassigned';
    const intentBand = searchParams.get('intent_band');
    const city = searchParams.get('city');
    const source = searchParams.get('source');
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '20')));
    const offset = (page - 1) * limit;

    // Build where conditions
    const conditions: ReturnType<typeof eq>[] = [];
    if (intentBand) conditions.push(eq(leads.intent_band, intentBand));
    if (source) conditions.push(eq(leads.lead_source, source));

    if (tab === 'unassigned') {
        // Leads with no assignment record
        const baseQuery = db
            .select({
                id: leads.id,
                business_name: leads.business_name,
                owner_name: leads.owner_name,
                owner_contact: leads.owner_contact,
                phone: leads.phone,
                city: leads.city,
                state: leads.state,
                lead_source: leads.lead_source,
                interest_level: leads.interest_level,
                lead_status: leads.lead_status,
                intent_score: leads.intent_score,
                intent_band: leads.intent_band,
                google_rating: leads.google_rating,
                google_ratings_count: leads.google_ratings_count,
                phone_quality: leads.phone_quality,
                do_not_call: leads.do_not_call,
                ai_managed: leads.ai_managed,
                total_ai_calls: leads.total_ai_calls,
                last_call_outcome: leads.last_call_outcome,
                conversation_summary: leads.conversation_summary,
                scraped_at: leads.scraped_at,
                created_at: leads.created_at,
            })
            .from(leads)
            .leftJoin(leadAssignments, eq(leads.id, leadAssignments.lead_id))
            .where(and(
                isNull(leadAssignments.lead_id),
                ...conditions,
                ...(city ? [sql`LOWER(${leads.city}) LIKE LOWER(${`%${city}%`})`] : []),
            ))
            .orderBy(desc(leads.created_at))
            .limit(limit)
            .offset(offset);

        const data = await baseQuery;

        // Count total
        const [{ count }] = await db
            .select({ count: sql<number>`COUNT(*)::int` })
            .from(leads)
            .leftJoin(leadAssignments, eq(leads.id, leadAssignments.lead_id))
            .where(and(
                isNull(leadAssignments.lead_id),
                ...conditions,
                ...(city ? [sql`LOWER(${leads.city}) LIKE LOWER(${`%${city}%`})`] : []),
            ));

        return successResponse({ data, total: count, page, limit });
    }

    // tab === 'assigned'
    const data = await db
        .select({
            id: leads.id,
            business_name: leads.business_name,
            owner_name: leads.owner_name,
            owner_contact: leads.owner_contact,
            phone: leads.phone,
            city: leads.city,
            state: leads.state,
            lead_source: leads.lead_source,
            interest_level: leads.interest_level,
            lead_status: leads.lead_status,
            intent_score: leads.intent_score,
            intent_band: leads.intent_band,
            phone_quality: leads.phone_quality,
            ai_managed: leads.ai_managed,
            total_ai_calls: leads.total_ai_calls,
            last_call_outcome: leads.last_call_outcome,
            conversation_summary: leads.conversation_summary,
            created_at: leads.created_at,
            // Assignment info
            assigned_owner_id: leadAssignments.lead_owner,
            assigned_owner_name: users.name,
            assigned_at: leadAssignments.assigned_at,
        })
        .from(leads)
        .innerJoin(leadAssignments, eq(leads.id, leadAssignments.lead_id))
        .leftJoin(users, eq(leadAssignments.lead_owner, users.id))
        .where(and(
            ...conditions,
            ...(city ? [sql`LOWER(${leads.city}) LIKE LOWER(${`%${city}%`})`] : []),
        ))
        .orderBy(desc(leadAssignments.assigned_at))
        .limit(limit)
        .offset(offset);

    const [{ count }] = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(leads)
        .innerJoin(leadAssignments, eq(leads.id, leadAssignments.lead_id))
        .where(and(
            ...conditions,
            ...(city ? [sql`LOWER(${leads.city}) LIKE LOWER(${`%${city}%`})`] : []),
        ));

    return successResponse({ data, total: count, page, limit });
});
