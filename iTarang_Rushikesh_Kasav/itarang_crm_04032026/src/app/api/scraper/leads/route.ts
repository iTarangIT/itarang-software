/**
 * GET /api/scraper/leads
 *
 * Sales Head / CEO / Business Head: returns ALL scraped leads.
 * Sales Manager: returns only leads assigned to them.
 *
 * Query params:
 *   status   – filter by exploration_status
 *   run_id   – filter by scraper run
 *   limit    – (default 50, max 200)
 *   offset   – (default 0)
 */

import { db } from '@/lib/db';
import { scrapedDealerLeads, users } from '@/lib/db/schema';
import { withErrorHandler, successResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { and, eq, desc } from 'drizzle-orm';

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole([
        'sales_head',
        'ceo',
        'business_head',
        'sales_manager',
    ]);

    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');
    const runId = searchParams.get('run_id');
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 200);
    const offset = parseInt(searchParams.get('offset') ?? '0');

    const conditions = [];

    // Role-based scoping
    if (user.role === 'sales_manager') {
        conditions.push(eq(scrapedDealerLeads.assigned_to, user.id));
    }
    if (status) {
        conditions.push(eq(scrapedDealerLeads.exploration_status, status));
    }
    if (runId) {
        conditions.push(eq(scrapedDealerLeads.scraper_run_id, runId));
    }

    const rows = await db
        .select({
            id: scrapedDealerLeads.id,
            scraper_run_id: scrapedDealerLeads.scraper_run_id,
            dealer_name: scrapedDealerLeads.dealer_name,
            phone: scrapedDealerLeads.phone,
            location_city: scrapedDealerLeads.location_city,
            location_state: scrapedDealerLeads.location_state,
            source_url: scrapedDealerLeads.source_url,
            exploration_status: scrapedDealerLeads.exploration_status,
            exploration_notes: scrapedDealerLeads.exploration_notes,
            explored_at: scrapedDealerLeads.explored_at,
            assigned_to: scrapedDealerLeads.assigned_to,
            assigned_at: scrapedDealerLeads.assigned_at,
            converted_lead_id: scrapedDealerLeads.converted_lead_id,
            created_at: scrapedDealerLeads.created_at,
            updated_at: scrapedDealerLeads.updated_at,
            email: scrapedDealerLeads.email,
            gst_number: scrapedDealerLeads.gst_number,
            business_type: scrapedDealerLeads.business_type,
            products_sold: scrapedDealerLeads.products_sold,
            website: scrapedDealerLeads.website,
            quality_score: scrapedDealerLeads.quality_score,
            phone_valid: scrapedDealerLeads.phone_valid,
            assigned_to_name: users.name,
        })
        .from(scrapedDealerLeads)
        .leftJoin(users, eq(scrapedDealerLeads.assigned_to, users.id))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(scrapedDealerLeads.created_at))
        .limit(limit)
        .offset(offset);

    return successResponse(rows);
});
