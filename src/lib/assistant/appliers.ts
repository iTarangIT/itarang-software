// Write tool → its applier. The executor looks the stored action's tool up here;
// a tool with no applier cannot be executed at all.

import type { WriteToolName } from "./types";
import type { Applier } from "./applierSpec";
import { logCallApplier } from "./tools/write/logCall";
import { setFollowUpApplier } from "./tools/write/setFollowUp";
import { logVisitApplier } from "./tools/write/logVisit";
import { markLostApplier } from "./tools/write/markLost";
import { claimLeadApplier } from "./tools/write/claimLead";

export const APPLIERS: Readonly<Record<WriteToolName, Applier<unknown>>> = Object.freeze({
    log_call: logCallApplier,
    set_follow_up: setFollowUpApplier,
    log_visit: logVisitApplier,
    mark_lost: markLostApplier,
    claim_lead: claimLeadApplier,
});
