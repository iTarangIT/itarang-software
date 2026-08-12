// Client-safe constants for the leads filter bar. Kept in its own module (no DB
// imports) so client components can import it without pulling the server-only
// query builder (and its postgres/net deps) into the bundle.
//
// Originally paired with the admin "Leads Info" page; that screen merged into
// /leads and its query builder is now src/lib/leads/leadListQuery.ts. This file
// stays put because both the filter bar and the query still need this sentinel.

// Sentinel status value for the "Unassigned" filter option. "Unassigned" means
// "no current owner" (current_owner_id IS NULL) rather than the specific
// New_Unassigned lead_status — most owner-less leads (AI-routed, null status,
// etc.) never carry that exact status, so filtering on it would miss them.
export const UNASSIGNED_FILTER = "__unassigned";
