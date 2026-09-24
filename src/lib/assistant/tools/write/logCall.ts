// log_call — a call, WhatsApp or note with its outcome (BRD §9.2). Proposes;
// never writes. Gate 4 builds the pending action and preview.

import { z } from "zod";
import { defineTool, LeadId, NOT_YET, ownedLeadOr, type ToolFactory } from "../spec";
import {
    Bucket,
    ConnectStatus,
    DispositionLabel,
    Interest,
    IsoDateTime,
    LostReason,
    Remarks,
    StatusChoice,
} from "./vocabSchemas";

export const logCall: ToolFactory = () => defineTool({
    name: "log_call",
    kind: "write",
    description:
        "Propose logging a call, WhatsApp chat or note on a lead the user owns, with its disposition and any status, " +
        "follow-up or interest change. Nothing is saved until the user taps Confirm on the preview.",
    schema: z
        .object({
            lead_id: LeadId,
            channel: z.enum(["call", "whatsapp", "note"]),
            connect_status: ConnectStatus.optional(),
            disposition: DispositionLabel.optional(),
            bucket: Bucket.optional(),
            status: StatusChoice.optional(),
            lost_reason: LostReason.optional(),
            follow_up_at: IsoDateTime.optional(),
            interest: Interest.optional(),
            duration_minutes: z.number().int().min(0).max(600).optional(),
            remarks: Remarks.optional(),
        })
        .refine((v) => v.channel !== "call" || (!!v.connect_status && !!v.disposition), {
            message: "a call needs connect_status and disposition",
            path: ["disposition"],
        }),
    run: async (ctx, input) => {
        const owned = await ownedLeadOr(ctx, input.lead_id);
        return owned.result ?? NOT_YET;
    },
});
