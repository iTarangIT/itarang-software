/**
 * E-367 — GET / PUT the "auto-assign AI-qualified leads to the area ASM" switch.
 *
 *   GET  → { settings, logReady, recent (last 50 decisions), uncovered (places
 *          with no ASM, last 30 days) }
 *   PUT  { enabled } → turns routing on / off.
 *
 * Stored in app_settings['territory_routing'] (src/lib/ai-dialer/territoryRouting.ts).
 */

import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import {
    getTerritoryRoutingSettings,
    routingOverview,
    setTerritoryRoutingSettings,
} from "@/lib/ai-dialer/territoryRouting";

export const dynamic = "force-dynamic";

const READ_ROLES = ["admin", "ceo", "sales_head"];
const WRITE_ROLES = ["admin", "sales_head"];

const BodySchema = z.object({ enabled: z.boolean() });

export const GET = withErrorHandler(async () => {
    await requireRole(READ_ROLES);
    const [settings, overview] = await Promise.all([getTerritoryRoutingSettings(), routingOverview(50)]);
    return successResponse({ settings, ...overview });
});

export const PUT = withErrorHandler(async (req: Request) => {
    const user = await requireRole(WRITE_ROLES);
    const body = BodySchema.parse(await req.json());
    const settings = await setTerritoryRoutingSettings({ enabled: body.enabled, updatedBy: user.id });
    return successResponse({ settings });
});
