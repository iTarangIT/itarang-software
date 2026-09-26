// Zod enums for the write tools, built from the EXISTING vocabularies only
// (Invariant 6). The §9.3 combination rules (which status may go with which
// disposition) are vocab.ts's job, checked when the preview is built.

import { z } from "zod";
import {
    ALL_CONNECTED_DISPOSITIONS,
    CONNECT_STATUS,
    DISPOSITION_BUCKETS,
    NOT_CONNECTED_REASONS,
} from "@/lib/leads/dispositions";
import { LEAD_STATUS, LOST_REASON } from "@/lib/lifecycle/transitions";
import { VISIT_NEXT_ACTION, VISIT_OUTCOME, VISIT_STATUS } from "@/lib/asm/types";
import { INTEREST_LEVELS } from "@/lib/admin/salesDashboardTypes";
import { NO_CHANGE } from "../../vocab";

const tuple = (xs: readonly string[]) => xs as unknown as [string, ...string[]];

export const DispositionLabel = z
    .enum(tuple([...ALL_CONNECTED_DISPOSITIONS, ...NOT_CONNECTED_REASONS]))
    .describe("The CC-sheet disposition, spelled exactly as listed");
export const ConnectStatus = z.enum(CONNECT_STATUS);
export const Bucket = z
    .enum(DISPOSITION_BUCKETS)
    .describe("Cold / Warm / Hot / Converted / Lost — only when the rep said it");
export const StatusChoice = z
    .enum(tuple([...LEAD_STATUS, NO_CHANGE]))
    .describe(`A lead status, or "${NO_CHANGE}". Omit when the rep did not say.`);
export const LostReason = z.enum(LOST_REASON);
export const Interest = z.enum(INTEREST_LEVELS);
export const VisitStatus = z.enum(VISIT_STATUS);
export const VisitOutcome = z.enum(VISIT_OUTCOME);
export const VisitNextAction = z.enum(VISIT_NEXT_ACTION);
/** An absolute instant with its offset, e.g. 2026-09-25T11:00:00+05:30. */
export const IsoDateTime = z.iso.datetime({ offset: true });
/** A calendar day, e.g. 2026-09-26 (IST). */
export const IsoDate = z.iso.date();
export const Remarks = z.string().trim().max(1000);
