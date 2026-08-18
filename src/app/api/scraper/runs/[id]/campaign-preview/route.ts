/**
 * GET /api/scraper/runs/[id]/campaign-preview
 *
 * What would happen if you pressed "Run Campaign" on this scrape run: which
 * cities it resolves to, how many leads are dialable there, and — the part
 * people actually need — why the rest are not.
 *
 * ⚠ THE AUDIENCE IS THE CITY, NOT THE RUN. A campaign started here targets every
 * dialable lead in the cities this run covered, not only the leads this run
 * produced. That is the intended behaviour and it is counter-intuitive on a page
 * headed "80 new leads saved", so the confirm sheet says so in as many words.
 * (It is also the only thing that CAN be built: promoteLeadsToDealerLeads writes
 * no run reference and never sets scraped_dealer_leads.converted_lead_id, so
 * there is no run→lead link to target.)
 *
 * GET with no side effects, so it is safe to refetch while the sheet is open.
 */

import { NextRequest } from "next/server";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { resolveDialerAudience } from "@/lib/ai-dialer/audience";
import { resolveRunCities } from "@/lib/scraper/runAudience";

export const GET = withErrorHandler(
    async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
        // Same roles as the run detail route this sits beside.
        await requireRole(["sales_head", "ceo", "business_head"]);

        const { id } = await params;
        const { cities, unresolvedRaw, source } = await resolveRunCities(id);

        if (cities.length === 0) {
            return successResponse({
                runId: id,
                cities: [],
                unresolvedRaw,
                citySource: source,
                preview: null,
                canRun: false,
                reason: "no_city_data" as const,
            });
        }

        const audience = await resolveDialerAudience({
            cities: cities.map((c) => ({ state: c.state as string, city: c.city })),
        });

        return successResponse({
            runId: id,
            cities,
            unresolvedRaw,
            citySource: source,
            preview: {
                counts: audience.counts,
                excluded: audience.excluded,
                totalWithPhone: audience.totalWithPhone,
                aiConnectedCount: audience.aiConnectedCount,
                queueIds: audience.queueIds,
            },
            canRun: audience.queueIds.length > 0,
            reason:
                audience.queueIds.length === 0
                    ? ("no_dialable_leads" as const)
                    : null,
        });
    },
);
