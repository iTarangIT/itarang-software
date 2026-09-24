// set_follow_up — the next action and date without a call (BRD §9.2).
// Role-aware (BRD §2.3-2): ISR → next_follow_up_at; ASM → a scheduled
// lead_visits row. Proposes; never writes. Gate 4.

import { z } from "zod";
import { defineTool, LeadId, NOT_YET, ownedLeadOr, type ToolFactory } from "../spec";
import { IsoDate, IsoDateTime, Remarks } from "./vocabSchemas";

export const setFollowUp: ToolFactory = (role) =>
    role === "asm"
        ? defineTool({
              name: "set_follow_up",
              kind: "write",
              description:
                  "Propose scheduling the next visit to a lead the ASM owns (it appears in Today's Schedule on that day). " +
                  "Nothing is saved until Confirm.",
              schema: z.object({ lead_id: LeadId, visit_date: IsoDate, note: Remarks.min(1) }),
              run: async (ctx, input) => (await ownedLeadOr(ctx, input.lead_id)).result ?? NOT_YET,
          })
        : defineTool({
              name: "set_follow_up",
              kind: "write",
              description:
                  "Propose setting the next follow-up date and time on a lead the user owns. Nothing is saved until Confirm.",
              schema: z.object({ lead_id: LeadId, follow_up_at: IsoDateTime, note: Remarks.min(1) }),
              run: async (ctx, input) => (await ownedLeadOr(ctx, input.lead_id)).result ?? NOT_YET,
          });
