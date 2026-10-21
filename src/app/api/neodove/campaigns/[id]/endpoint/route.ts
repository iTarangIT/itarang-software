// POST /api/neodove/campaigns/[id]/endpoint — A32: Admin pastes a campaign's
// NeoDove Custom Integration URL; it is stored encrypted (E-351) and the
// campaign is pointed at it. Write-only: the response, like every other route,
// carries only the last 4 characters — the URL is the credential.
//
// Body: { kind: "push" | "update", url: string }

import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { endpointStoreStatus, saveCampaignEndpoint, validEndpointUrl } from "@/lib/neodove/endpointStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin only (13 Oct proposed answer): the URL grants write access to the NeoDove campaign. */
const ENDPOINT_ROLES = ["admin"];

const Body = z.object({
    kind: z.enum(["push", "update"]).default("push"),
    url: z.string().trim().min(10).max(2000),
});

export const POST = withErrorHandler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole(ENDPOINT_ROLES);
    const { id } = await ctx.params;
    const b = Body.parse(await req.json());

    const status = await endpointStoreStatus();
    if (!status.ready) return errorResponse(status.reason ?? "The endpoint store is not set up.", 503);
    const bad = validEndpointUrl(b.url);
    if (bad) return errorResponse(bad, 400);

    const found = (await db.execute(sql`SELECT 1 FROM neodove_campaigns WHERE id = ${id}`)) as unknown as unknown[];
    if (!found.length) return errorResponse("Campaign not found", 404);

    const { last4 } = await saveCampaignEndpoint({ campaignId: id, kind: b.kind, url: b.url, actorId: user.id });
    console.log(`[neodove] ${b.kind} endpoint for ${id} stored by ${user.id} (…${last4})`);
    return successResponse({ kind: b.kind, last4 });
});
