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
import { transferToAsm } from "./tools/write/transferToAsm";
import { reassignLead } from "./tools/write/reassignLead";
import { escalateLead } from "./tools/write/escalateLead";
import { markConverted } from "./tools/write/markConverted";
import { inviteDealerOnboarding } from "./tools/write/inviteDealerOnboarding";
import { createLead } from "./tools/write/createLead";
import { productCatalogue } from "./tools/read/productCatalogue";
import { quoteStatus } from "./tools/read/quoteStatus";
import { createQuote } from "./tools/write/createQuote";
import { sendQuote } from "./tools/write/sendQuote";

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
    transfer_to_asm: transferToAsm,
    reassign_lead: reassignLead,
    escalate_lead: escalateLead,
    mark_converted: markConverted,
    invite_dealer_onboarding: inviteDealerOnboarding,
    create_lead: createLead,
    product_catalogue: productCatalogue,
    quote_status: quoteStatus,
    create_quote: createQuote,
    send_quote: sendQuote,
});

/**
 * BRD §5: log_visit is ASM-only; transfer_to_asm is ISR-only (the screen's
 * Transfer button is not offered to an ASM — an ASM hands back with
 * reassign_lead). Everything else is both roles — including the quote tools
 * (product_catalogue, quote_status, create_quote, send_quote).
 */
export const ROLE_TOOLS: Readonly<Record<AssistantRole, readonly ToolName[]>> = Object.freeze({
    inside_sales_rep: Object.freeze([
        "my_queue", "search_lead", "get_lead_details", "my_numbers",
        "log_call", "mark_lost", "claim_lead", "set_follow_up",
        "transfer_to_asm", "reassign_lead", "escalate_lead", "mark_converted",
        "invite_dealer_onboarding", "create_lead",
        "product_catalogue", "quote_status", "create_quote", "send_quote",
    ] as const),
    asm: Object.freeze([
        "my_queue", "search_lead", "get_lead_details", "my_numbers",
        "log_call", "log_visit", "mark_lost", "claim_lead", "set_follow_up",
        "reassign_lead", "escalate_lead", "mark_converted", "invite_dealer_onboarding", "create_lead",
        "product_catalogue", "quote_status", "create_quote", "send_quote",
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
