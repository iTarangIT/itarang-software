/**
 * GET /api/scraper/runs/[id]
 * Returns a single scraper run's details including its leads and dedup logs.
 */

import { db } from '@/lib/db';
import { scraperRuns, scrapedDealerLeads, scraperDedupLogs, users } from '@/lib/db/schema';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { eq, desc } from 'drizzle-orm';

export const GET = withErrorHandler(
    async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
        await requireRole(['sales_head', 'ceo', 'business_head']);

        const { id } = await params;

        const [run] = await db
            .select({
                id: scraperRuns.id,
                status: scraperRuns.status,
                started_at: scraperRuns.started_at,
                completed_at: scraperRuns.completed_at,
                search_queries: scraperRuns.search_queries,
                total_found: scraperRuns.total_found,
                new_leads_saved: scraperRuns.new_leads_saved,
                duplicates_skipped: scraperRuns.duplicates_skipped,
                error_message: scraperRuns.error_message,
                triggered_by_name: users.name,
            })
            .from(scraperRuns)
            .leftJoin(users, eq(scraperRuns.triggered_by, users.id))
            .where(eq(scraperRuns.id, id))
            .limit(1);

        if (!run) return errorResponse('Run not found', 404);

        const scrapeLeads = await db
            .select({
                id: scrapedDealerLeads.id,
                dealer_name: scrapedDealerLeads.dealer_name,
                phone: scrapedDealerLeads.phone,
                location_city: scrapedDealerLeads.location_city,
                location_state: scrapedDealerLeads.location_state,
                source_url: scrapedDealerLeads.source_url,
                exploration_status: scrapedDealerLeads.exploration_status,
                assigned_to: scrapedDealerLeads.assigned_to,
                assigned_at: scrapedDealerLeads.assigned_at,
                created_at: scrapedDealerLeads.created_at,
                email: scrapedDealerLeads.email,
                gst_number: scrapedDealerLeads.gst_number,
                business_type: scrapedDealerLeads.business_type,
                products_sold: scrapedDealerLeads.products_sold,
                website: scrapedDealerLeads.website,
                quality_score: scrapedDealerLeads.quality_score,
                phone_valid: scrapedDealerLeads.phone_valid,
                converted_lead_id: scrapedDealerLeads.converted_lead_id,
                assigned_to_name: users.name,
            })
            .from(scrapedDealerLeads)
            .leftJoin(users, eq(scrapedDealerLeads.assigned_to, users.id))
            .where(eq(scrapedDealerLeads.scraper_run_id, id))
            .orderBy(desc(scrapedDealerLeads.created_at));

        const dedupLogs = await db
            .select()
            .from(scraperDedupLogs)
            .where(eq(scraperDedupLogs.scraper_run_id, id))
            .orderBy(desc(scraperDedupLogs.created_at));

        return successResponse({ run, leads: scrapeLeads, dedup_logs: dedupLogs });
    }
);
