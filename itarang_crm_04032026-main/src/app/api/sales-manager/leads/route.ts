import { db } from '@/lib/db';
import { leads, leadAssignments } from '@/lib/db/schema';
import { eq, or, desc, sql } from 'drizzle-orm';
import { withErrorHandler, successResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['sales_manager']);

    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '20')));
    const offset = (page - 1) * limit;

    // Find leads assigned to this user as owner or actor
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
            intent_reason: leads.intent_reason,
            phone_quality: leads.phone_quality,
            ai_managed: leads.ai_managed,
            total_ai_calls: leads.total_ai_calls,
            last_call_outcome: leads.last_call_outcome,
            last_ai_call_at: leads.last_ai_call_at,
            conversation_summary: leads.conversation_summary,
            intent_details: leads.intent_details,
            website: leads.website,
            google_rating: leads.google_rating,
            created_at: leads.created_at,
        })
        .from(leads)
        .innerJoin(leadAssignments, eq(leads.id, leadAssignments.lead_id))
        .where(or(
            eq(leadAssignments.lead_owner, user.id),
            eq(leadAssignments.lead_actor, user.id),
        ))
        .orderBy(desc(leads.updated_at))
        .limit(limit)
        .offset(offset);

    const [{ count }] = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(leads)
        .innerJoin(leadAssignments, eq(leads.id, leadAssignments.lead_id))
        .where(or(
            eq(leadAssignments.lead_owner, user.id),
            eq(leadAssignments.lead_actor, user.id),
        ));

    return successResponse({ data, total: count, page, limit });
});
