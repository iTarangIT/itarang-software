
import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { withErrorHandler, successResponse } from '@/lib/api-utils';
import { sql, desc, and, or, isNull, lte } from 'drizzle-orm';

export const POST = withErrorHandler(async (req: Request) => {
    // Logic:
    // Skip do_not_call = true
    // Skip next_call_after > now
    // Sort priority:
    // 1. Never called (last_ai_call_at IS NULL)
    // 2. Oldest last_ai_call_at
    // 3. Boost interest_level (hot > warm > cold)

    const now = new Date();

    const rankedLeads = await db.select({
        id: leads.id,
        owner_name: leads.owner_name,
        owner_contact: leads.owner_contact,
        interest_level: leads.interest_level,
        last_ai_call_at: leads.last_ai_call_at,
        ai_priority_score: leads.ai_priority_score,
    })
        .from(leads)
        .where(
            and(
                eq(leads.do_not_call, false),
                or(
                    isNull(leads.next_call_after),
                    lte(leads.next_call_after, now)
                )
            )
        )
        .orderBy(
            desc(sql`CASE 
            WHEN ${leads.interest_level} = 'hot' THEN 3 
            WHEN ${leads.interest_level} = 'warm' THEN 2 
            ELSE 1 
        END`),
            desc(sql`CASE WHEN ${leads.last_ai_call_at} IS NULL THEN 1 ELSE 0 END`),
            leads.last_ai_call_at
        )
        .limit(20);

    // Add a simple mock score for now as requested (MVP ranking)
    const scoredLeads = rankedLeads.map((lead, index) => ({
        ...lead,
        rank_score: 100 - (index * 5)
    }));

    return successResponse(scoredLeads);
});

// Helper for 'eq' which might not be imported from drizzle-orm but is standard
import { eq } from 'drizzle-orm';
