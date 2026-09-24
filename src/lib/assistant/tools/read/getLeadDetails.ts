// get_lead_details — one lead's picture: contact, status, interest, owner,
// last touchpoints and visits. Scope-checked now; the detail bundle is Gate 3.

import { z } from "zod";
import { defineTool, LeadId, scopedLeadOr, type ToolFactory } from "../spec";

export const getLeadDetails: ToolFactory = () => defineTool({
    name: "get_lead_details",
    kind: "read",
    description: "Show one lead the user can see: contact, status, interest, owner, recent history and a CRM link.",
    schema: z.object({ lead_id: LeadId }),
    run: async (ctx, input) => {
        const scoped = await scopedLeadOr(ctx, input.lead_id);
        if (scoped.result) return scoped.result;
        return { kind: "unavailable", message: "Lead details arrive in the next release." };
    },
});
