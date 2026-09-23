// GET / PUT /api/neodove/agents — the NeoDove agent → CRM user map (review R-03).
//
// GET lists every agent name NeoDove has sent on a call, with call and
// unattributed counts, the confirmed CRM user (if any) and a name-based
// suggestion. PUT maps or unmaps ONE agent and re-points that agent's existing
// calls in the same transaction (see src/lib/neodove/agentMap.ts).
//
// Viewing is open to NEODOVE_ADMIN_ROLES like the rest of the NeoDove screens.
// Editing is narrower: a mapping decides whose numbers every CC call counts on,
// so it belongs to the people who own those numbers.

import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import {
    AgentMapError,
    listNeodoveAgents,
    setNeodoveAgentMapping,
} from "@/lib/neodove/agentMap";
import { NEODOVE_ADMIN_ROLES } from "@/lib/neodove/roles";

export const dynamic = "force-dynamic";

const EDITOR_ROLES = ["admin", "ceo", "sales_head"];

const BodySchema = z.object({
    agent: z.string().trim().min(1).max(120),
    user_id: z.string().trim().min(1).max(64).nullable(),
});

export const GET = withErrorHandler(async () => {
    const user = await requireRole(NEODOVE_ADMIN_ROLES);
    const summary = await listNeodoveAgents();
    return successResponse({ ...summary, can_edit: EDITOR_ROLES.includes(user.role) });
});

export const PUT = withErrorHandler(async (req: Request) => {
    const user = await requireRole(EDITOR_ROLES);
    const { agent, user_id } = BodySchema.parse(await req.json());
    try {
        const { moved } = await setNeodoveAgentMapping(agent, user_id, user.id);
        return successResponse({ moved });
    } catch (e) {
        if (e instanceof AgentMapError) return errorResponse(e.message, 400);
        throw e;
    }
});
