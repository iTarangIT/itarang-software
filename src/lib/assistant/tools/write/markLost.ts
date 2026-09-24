// mark_lost — close a lead as Lost with one of the 11 reasons (BRD §9.2).
// `other` needs notes; the 4 high-impact reasons need a second Confirm. Gate 5.

import { z } from "zod";
import { defineTool, LeadId, NOT_YET, ownedLeadOr, type ToolFactory } from "../spec";
import { LostReason, Remarks } from "./vocabSchemas";

export const markLost: ToolFactory = () => defineTool({
    name: "mark_lost",
    kind: "write",
    description:
        "Propose closing a lead the user owns as Lost, with a lost reason (notes required for 'other'). " +
        "High-impact reasons need a second confirmation. Nothing is saved until Confirm.",
    schema: z
        .object({ lead_id: LeadId, lost_reason: LostReason, notes: Remarks.optional() })
        .refine((v) => v.lost_reason !== "other" || !!v.notes?.trim(), {
            message: "notes are required when lost_reason is other",
            path: ["notes"],
        }),
    run: async (ctx, input) => {
        const owned = await ownedLeadOr(ctx, input.lead_id);
        return owned.result ?? NOT_YET;
    },
});
