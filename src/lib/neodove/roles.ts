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
