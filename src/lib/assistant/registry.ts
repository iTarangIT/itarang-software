// Which tools exist for a user (BRD §8.2 Tool registry, §9).
//
// The model decides which tool to CALL; this decides which tools EXIST for the
// caller. Unknown role → no tools at all. Write tools are listed only for users
// on the pilot allow-list (ASSISTANT_WRITES_ENABLED_USER_IDS); everyone else
// simply has no write tool to call. Each tool re-checks role, scope and
// ownership itself, so this list is a first gate, not the only one.

import { isAssistantRole, READ_TOOL_NAMES, type AssistantRole, type ToolName } from "./types";
import type { ToolFactory, ToolSpec } from "./tools/spec";
import { myQueue } from "./tools/read/myQueue";
import { searchLead } from "./tools/read/searchLead";
import { getLeadDetails } from "./tools/read/getLeadDetails";
import { myNumbers } from "./tools/read/myNumbers";
import { logCall } from "./tools/write/logCall";
import { logVisit } from "./tools/write/logVisit";
import { markLost } from "./tools/write/markLost";
import { claimLead } from "./tools/write/claimLead";
import { setFollowUp } from "./tools/write/setFollowUp";

const FACTORIES: Readonly<Record<ToolName, ToolFactory>> = Object.freeze({
    my_queue: myQueue,
    search_lead: searchLead,
    get_lead_details: getLeadDetails,
    my_numbers: myNumbers,
    log_call: logCall,
    log_visit: logVisit,
    mark_lost: markLost,
    claim_lead: claimLead,
    set_follow_up: setFollowUp,
});

/** BRD §5: log_visit is ASM-only; everything else is both roles. */
export const ROLE_TOOLS: Readonly<Record<AssistantRole, readonly ToolName[]>> = Object.freeze({
    inside_sales_rep: Object.freeze([
        "my_queue", "search_lead", "get_lead_details", "my_numbers",
        "log_call", "mark_lost", "claim_lead", "set_follow_up",
    ] as const),
    asm: Object.freeze([
        "my_queue", "search_lead", "get_lead_details", "my_numbers",
        "log_call", "log_visit", "mark_lost", "claim_lead", "set_follow_up",
    ] as const),
});

const isRead = (n: ToolName) => (READ_TOOL_NAMES as readonly string[]).includes(n);

/** Tool names for a role. Unknown role → []. Writes only when enabled. */
export function toolNamesFor(role: string | null | undefined, writesEnabled: boolean): ToolName[] {
    if (!isAssistantRole(role)) return [];
    return ROLE_TOOLS[role].filter((n) => writesEnabled || isRead(n));
}

/** The tool specs for a role, schemas built for that role. */
export function toolsFor(role: string | null | undefined, writesEnabled: boolean): ToolSpec[] {
    if (!isAssistantRole(role)) return [];
    return toolNamesFor(role, writesEnabled).map((n) => FACTORIES[n](role));
}
