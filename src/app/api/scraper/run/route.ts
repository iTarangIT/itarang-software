/**
 * POST /api/scraper/run  — Trigger a new scraper run (Sales Head only)
 * GET  /api/scraper/run  — List all scraper runs (with pagination)
 *
 * POST is fire-and-forget: it creates the run record and immediately returns
 * the run ID. The heavy scraping work happens in the background.
 */

import { db } from '@/lib/db';
import { scraperRuns, users } from '@/lib/db/schema';
import { generateId, withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { runDealerScraper } from '@/lib/dealer-scraper-service';
import { desc, eq } from 'drizzle-orm';

// Increase serverless timeout for scraper runs
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// POST — Trigger scraper
// ---------------------------------------------------------------------------
export const POST = withErrorHandler(async () => {
    const user = await requireRole(['sales_head', 'ceo', 'business_head']);

    // Prevent concurrent runs
    const [running] = await db
        .select({ id: scraperRuns.id })
        .from(scraperRuns)
        .where(eq(scraperRuns.status, 'running'))
        .limit(1);

    if (running) {
        return errorResponse(
            `A scraper run is already in progress (${running.id}). ` +
            'Wait for it to complete before starting a new one.',
            409
        );
    }

    // Create the run record (status: running)
    const runId = await generateId('SCRAPE', scraperRuns);
    await db.insert(scraperRuns).values({
        id: runId,
        triggered_by: user.id,
        status: 'running',
        started_at: new Date(),
    });

    // Fire and forget — do not await
    runDealerScraper(runId).catch((err) =>
        console.error(`[Scraper] Background run failed for ${runId}:`, err)
    );

    return successResponse(
        {
            run_id: runId,
            message: 'Scraper started. Check run status for progress.',
        },
        202
    );
});

// ---------------------------------------------------------------------------
// GET — List runs (most recent first)
// ---------------------------------------------------------------------------
export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(['sales_head', 'ceo', 'business_head']);

    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '20'), 100);
    const offset = parseInt(searchParams.get('offset') ?? '0');

    const rows = await db
        .select({
            id: scraperRuns.id,
            status: scraperRuns.status,
            started_at: scraperRuns.started_at,
            completed_at: scraperRuns.completed_at,
            total_found: scraperRuns.total_found,
            new_leads_saved: scraperRuns.new_leads_saved,
            duplicates_skipped: scraperRuns.duplicates_skipped,
            error_message: scraperRuns.error_message,
            triggered_by_name: users.name,
        })
        .from(scraperRuns)
        .leftJoin(users, eq(scraperRuns.triggered_by, users.id))
        .orderBy(desc(scraperRuns.started_at))
        .limit(limit)
        .offset(offset);

    return successResponse(rows);
});
