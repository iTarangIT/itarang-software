// Roles allowed to configure and run NeoDove campaigns (E-224).
//
// Mirrors the Bulk Lead Upload gate: pushing the prospect pool to an external
// telecalling vendor is the same class of action as importing it, and consumes
// the NeoDove plan's lead quota, so it is not an individual-rep capability.
//
// In its own module rather than a route file so route handlers don't import
// each other — importing a route module for a constant drags its handlers and
// their side effects along with it.
export const NEODOVE_ADMIN_ROLES = [
    "admin",
    "sales_head",
    "business_head",
    "ceo",
    "sales_manager",
];

// Roles a pushed lead may be assigned to in the CRM (E-237).
//
// DELIBERATELY NARROWER THAN "anyone who could own a lead", and the reason is a
// data-visibility trap rather than a permission one. Every pushed lead has
// lead_status = NULL — that is what isAiDialable requires — and every workspace
// queue filters on lead_status. assignLeadOwner only LIFTS that status for two
// roles, because only those two have a queue to lift into: inside_sales_rep
// (→ Assigned_Not_Contacted) and asm (→ Transferred_to_ASM). Any other role
// takes the plain-swap branch, leaving a lead that has an owner but still has a
// NULL status — which satisfies neither "My Open Leads" (needs a status IN
// OPEN_STATUSES) nor "Unassigned (Claim)" (needs current_owner_id IS NULL), so
// it lands on nobody's page. That is the E-140 bug, and offering those roles in
// the picker would reintroduce it through a brand-new feature.
//
// Widening this list is therefore not a one-line change — the new role needs a
// status-lifting branch in assignLeadOwner first, or its leads land nowhere.
//
// `asm` was initially excluded and then added on request. The reservation was
// semantic rather than technical: its branch lifts to Transferred_to_ASM, a
// status that normally asserts an engagement a cold hand-off to a calling
// campaign has not had. It IS safe — the lead lands correctly in that ASM's
// workspace, and pre_transfer_status is stamped so the original state survives
// — but an ASM-assigned pushed lead will read as "transferred" on the timeline
// before anyone has spoken to the dealer.
export const NEODOVE_ASSIGNEE_ROLES = ["inside_sales_rep", "asm"];
