// Write tool → its applier. The executor looks the stored action's tool up here;
// a tool with no applier cannot be executed at all (log_visit, mark_lost and
// claim_lead arrive in Gate 5).

import type { WriteToolName } from "./types";
import type { Applier } from "./applierSpec";
import { logCallApplier } from "./tools/write/logCall";
import { setFollowUpApplier } from "./tools/write/setFollowUp";

export const APPLIERS: Readonly<Partial<Record<WriteToolName, Applier<unknown>>>> = Object.freeze({
    log_call: logCallApplier,
    set_follow_up: setFollowUpApplier,
});
