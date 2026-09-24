// log_visit — an ASM's field visit and what comes next (BRD §9.2, UC-01).
// Mirrors the visit route's rules. Proposes; never writes. Gate 5.

import { z } from "zod";
import { defineTool, LeadId, NOT_YET, ownedLeadOr, type ToolFactory } from "../spec";
import {
    Interest,
    IsoDate,
    LostReason,
    Remarks,
    StatusChoice,
    VisitNextAction,
    VisitOutcome,
    VisitStatus,
} from "./vocabSchemas";

export const logVisit: ToolFactory = () => defineTool({
    name: "log_visit",
    kind: "write",
    description:
        "Propose logging a field visit on a lead the ASM owns: visit status, outcome, remarks, next action and next-visit date, " +
        "with optional interest or status change. 'Convert' is not done here — send the CRM link. Nothing is saved until Confirm.",
    schema: z
        .object({
            lead_id: LeadId,
            visit_status: VisitStatus,
            outcome: VisitOutcome.optional(),
            remarks: Remarks.min(1),
            next_action: VisitNextAction,
            next_visit_date: IsoDate.optional(),
            interest: Interest.optional(),
            status: StatusChoice.optional(),
            lost_reason: LostReason.optional(),
        })
        .refine((v) => v.visit_status !== "visited" || !!v.outcome, {
            message: "outcome is required when visit_status is visited",
            path: ["outcome"],
        })
        .refine((v) => v.next_action !== "next_visit" || !!v.next_visit_date, {
            message: "next_visit_date is required when next_action is next_visit",
            path: ["next_visit_date"],
        }),
    run: async (ctx, input) => {
        const owned = await ownedLeadOr(ctx, input.lead_id);
        return owned.result ?? NOT_YET;
    },
});
