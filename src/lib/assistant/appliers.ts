// Write tool → its applier. The executor looks the stored action's tool up here;
// a tool with no applier cannot be executed at all.

import type { WriteToolName } from "./types";
import type { Applier } from "./applierSpec";
import { logCallApplier } from "./tools/write/logCall";
import { setFollowUpApplier } from "./tools/write/setFollowUp";
import { logVisitApplier } from "./tools/write/logVisit";
import { markLostApplier } from "./tools/write/markLost";
import { claimLeadApplier } from "./tools/write/claimLead";
import { transferToAsmApplier } from "./tools/write/transferToAsm";
import { reassignLeadApplier } from "./tools/write/reassignLead";
import { escalateLeadApplier } from "./tools/write/escalateLead";
import { markConvertedApplier } from "./tools/write/markConverted";
import { inviteDealerOnboardingApplier } from "./tools/write/inviteDealerOnboarding";
import { createLeadApplier } from "./tools/write/createLead";

export const APPLIERS: Readonly<Record<WriteToolName, Applier<unknown>>> = Object.freeze({
    log_call: logCallApplier,
    set_follow_up: setFollowUpApplier,
    log_visit: logVisitApplier,
    mark_lost: markLostApplier,
    claim_lead: claimLeadApplier,
    transfer_to_asm: transferToAsmApplier,
    reassign_lead: reassignLeadApplier,
    escalate_lead: escalateLeadApplier,
    mark_converted: markConvertedApplier,
    invite_dealer_onboarding: inviteDealerOnboardingApplier,
    create_lead: createLeadApplier,
});
