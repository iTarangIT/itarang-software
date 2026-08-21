// GET /api/ai-dialer/campaigns/[id]/duration-histogram
//
// The call-duration distribution for ONE campaign's connected calls, plus the
// reason mix inside each bucket. Backs the panel that opens under the Completed
// stat card on the campaign detail page.
//
// Scoped to a single campaign on purpose — the question this answers is "why did
// THIS campaign do badly", and a global pool cannot answer it.
//
// All the work lives in @/lib/ai-dialer/call-duration: the SQL builder, the
// bucket config, and the pure fold that turns rows into percentages. This file
// is wiring. It is also a NEW directory rather than another branch inside the
// sibling [id]/route.ts, which keeps it clear of the in-flight campaign-schedule
// edits on that file.
//
// AUTH: none beyond the session, matching the sibling [id]/leads route. This
// endpoint returns strictly less than the lead table already rendered on the
// same page — counts and reasons, no names, no phone numbers, no transcripts —
// and src/middleware.ts already requires an authenticated session for /api/*.
// (export.xlsx does gate by role, because a downloaded file leaves the building.)
import { db } from "@/lib/db";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { resolveDurationBucketConfig } from "@/lib/ai-dialer/call-duration/config-store";
import {
    buildDurationHistogramSql,
    foldDurationHistogram,
    type DurationHistogramRow,
} from "@/lib/ai-dialer/call-duration/histogram";

export const GET = withErrorHandler(
    async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const { id: campaignId } = await ctx.params;
        if (!campaignId) return errorResponse("Campaign id required", 400);

        const { config, buckets, source } = await resolveDurationBucketConfig();

        // Left untyped at the driver boundary and asserted here: db.execute's
        // generic demands an index signature, and widening DurationHistogramRow
        // to Record<string, unknown> would let a misspelled column pass the
        // compiler and surface as a silent zero in the chart.
        const rows = await db.execute(buildDurationHistogramSql(campaignId, buckets));

        return successResponse(
            foldDurationHistogram(
                Array.from(rows) as unknown as DurationHistogramRow[],
                buckets,
                { edgesSeconds: config.edgesSeconds, source },
                campaignId,
            ),
        );
    },
);
