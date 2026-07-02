// Client-safe constants for the admin "Leads Info" filters. Kept in its own
// module (no DB imports) so client components can import it without pulling the
// server-only leadsInfoQuery.ts (and its postgres/net deps) into the bundle.

// Sentinel status value for the "Unassigned" filter option. "Unassigned" means
// "no current owner" (current_owner_id IS NULL) rather than the specific
// New_Unassigned lead_status — most owner-less leads (AI-routed, null status,
// etc.) never carry that exact status, so filtering on it would miss them.
export const UNASSIGNED_FILTER = "__unassigned";
