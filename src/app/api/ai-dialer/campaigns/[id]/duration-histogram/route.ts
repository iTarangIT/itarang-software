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
import { buildCallQualityFunnel } from "@/lib/ai-dialer/call-quality/funnel";
import {
    asCallQualityRows,
    buildCallQualitySql,
    hasTranscriptTurnsColumn,
} from "@/lib/ai-dialer/call-quality/query";

export const GET = withErrorHandler(
    async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const { id: campaignId } = await ctx.params;
        if (!campaignId) return errorResponse("Campaign id required", 400);

        const { config, buckets, source } = await resolveDurationBucketConfig();

        // Left untyped at the driver boundary and asserted here: db.execute's
        // generic demands an index signature, and widening DurationHistogramRow
        // to Record<string, unknown> would let a misspelled column pass the
        // compiler and surface as a silent zero in the chart.
        //
        // The two queries run concurrently: they are independent reads against
        // the same two tables, and serialising them would make the panel wait
        // for the sum of both round trips for no benefit.
        // E-267 may not be applied here, and the application cannot assume
        // either way — the column is deliberately absent from schema.ts so an
        // unapplied migration cannot break call logging. Naming it in the
        // SELECT regardless would fail this whole panel with 42703, so ask
        // first. The probe is memoised per process, so this is one extra query
        // on the first request and none after.
        const withTurns = await hasTranscriptTurnsColumn();

        const [histogramRows, funnelRows] = await Promise.all([
            db.execute(buildDurationHistogramSql(campaignId, buckets)),
            db.execute(buildCallQualitySql(campaignId, { withTurns })),
        ]);

        const histogram = foldDurationHistogram(
            Array.from(histogramRows) as unknown as DurationHistogramRow[],
            buckets,
            { edgesSeconds: config.edgesSeconds, source },
            campaignId,
        );

        // ONE endpoint rather than two, deliberately. The funnel's `answered`
        // and the histogram's `connectedLeads` are the same rule from the same
        // module; served by two endpoints they would be two independent
        // definitions that could drift apart, which is precisely the failure the
        // duration fix just closed.
        return successResponse({
            ...histogram,
            funnel: buildCallQualityFunnel(asCallQualityRows(funnelRows)),
        });
    },
);
