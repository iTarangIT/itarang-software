/**
 * POST /api/scraper/runs/[id]/campaign
 *
 * Start an AI dialer campaign for the cities a finished scrape run covered.
 *
 * Body: { provider }. That is all — the server RE-RESOLVES the audience from the
 * run id and ignores anything else the client sends.
 *
 * That is deliberately stricter than /api/ai-dialer/start, which "trusts
 * queueIds as authoritative". Here the audience is derivable from the run, so
 * there is no reason to accept it from the client — and it closes the staleness
 * window between opening the confirm sheet and pressing Start, which matters
 * more now that the AI-connected block can make a lead ineligible in between.
 */

import { NextRequest } from "next/server";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth, requireRole } from "@/lib/auth-utils";
import { resolveDialerAudience } from "@/lib/ai-dialer/audience";
import { citiesLabel, resolveRunCities } from "@/lib/scraper/runAudience";
import { createCampaign } from "@/lib/queue/campaignTracker";
import { startDraftCampaign } from "@/lib/queue/startCampaign";
import type { DialerProvider } from "@/lib/queue/dialerSession";

const ALLOWED_PROVIDERS: DialerProvider[] = ["bolna", "elevenlabs"];

export const POST = withErrorHandler(
    async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
        await requireRole(["sales_head", "ceo", "business_head"]);

        const { id: runId } = await params;
        const body = (await req.json().catch(() => ({}))) as {
            provider?: unknown;
        };
        const provider: DialerProvider = ALLOWED_PROVIDERS.includes(
            body.provider as DialerProvider,
        )
            ? (body.provider as DialerProvider)
            : "bolna";

        const { cities } = await resolveRunCities(runId);
        if (cities.length === 0) {
            return errorResponse(
                "No city was recorded for this run's searches, so a campaign cannot be scoped to it.",
                409,
            );
        }

        const audience = await resolveDialerAudience({
            cities: cities.map((c) => ({ state: c.state as string, city: c.city })),
        });

        if (audience.queueIds.length === 0) {
            const blocked = audience.excluded.byReason.already_ai_connected ?? 0;
            return errorResponse(
                blocked > 0
                    ? `Nothing left to dial in ${citiesLabel(cities)} — all ${blocked} reachable leads have already been contacted by the AI.`
                    : `No dialable leads found in ${citiesLabel(cities)}.`,
                409,
            );
        }

        let triggeredBy: string | null = null;
        try {
            const user = await requireAuth();
            triggeredBy = (user as { id?: string } | null)?.id ?? null;
        } catch {
            triggeredBy = null;
        }

        const ts = new Date().toLocaleString("en-IN", {
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
        });

        // Created as a draft and then started, rather than status:"running".
        // startDraftCampaign is the same primitive the Lists flow uses and it
        // brings provider tagging, the Redis dialer session and the first call
        // with it — so this path cannot drift from that one.
        const { campaignId, queued, blockedAiConnected } = await createCampaign({
            queueIds: audience.queueIds,
            provider,
            category: "all",
            status: "draft",
            name: `Scrape run · ${citiesLabel(cities)} · ${ts}`,
            triggeredBy,
            region: {
                states: [],
                cities: cities.map((c) => ({ state: c.state as string, city: c.city })),
                pincodes: [],
                groupIds: [],
                // Read by summarizeRegion/describeRegion for the history chip.
                // `kind` is compared with EQUALITY at /api/ai-dialer/campaigns
                // (kind === "list"), so "scrape_run" correctly stays out of the
                // Lists tab.
                kind: "scrape_run",
                runId,
                runCities: cities,
            },
        });

        if (!campaignId) {
            return errorResponse(
                "Could not create the campaign. Please try again.",
                500,
            );
        }

        const started = await startDraftCampaign(campaignId, provider);

        return successResponse({
            campaignId,
            queued,
            blockedAiConnected: blockedAiConnected.length,
            cities,
            firstCallPlaced: started.firstCallPlaced,
            firstCallError: started.firstCallError,
        });
    },
);
