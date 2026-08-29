// Campaign vocabulary shared by the SERVER query builder and the CLIENT filter
// bar — and therefore deliberately DEPENDENCY-FREE.
//
// ⚠ NOTHING IN THIS FILE MAY IMPORT db, drizzle, OR ANY SERVER MODULE.
//
// These constants used to live in leadListQuery.ts / leadCampaign.ts. Both of
// those import `@/lib/db`, which imports `postgres`, which imports node's `fs`,
// `net`, `tls` and `perf_hooks`. A client component importing a TYPE from such a
// module is free — types are erased — but importing a VALUE (CAMPAIGN_NONE) is a
// real runtime import, and it pulls the entire driver into the browser bundle.
// The failure is a hard build error, not a warning:
//
//     Module not found: Can't resolve 'fs'
//     ./node_modules/postgres/src/index.js [Client Component Browser]
//     ./src/lib/db/index.ts → leadListQuery.ts → LeadsFilterBar.tsx
//
// So anything a client component needs at RUNTIME belongs here, not there.

/** The two independent campaign systems a lead can belong to. */
export type CampaignSystem = "ai_dialer" | "neodove";

/**
 * Filter sentinel for "not in any campaign".
 *
 * Double-underscored so it cannot collide with a real id: dialer campaigns are
 * `camp_*` and NeoDove ones `NDC-*`.
 */
export const CAMPAIGN_NONE = "__none__";

export const CAMPAIGN_SYSTEM_LABEL: Record<CampaignSystem, string> = {
    ai_dialer: "AI Dialer",
    neodove: "NeoDove",
};

/**
 * Group order for the campaign dropdown. AI Dialer first because it holds the
 * overwhelming majority of campaigned leads, so the group anyone is looking for
 * is the one they see without scrolling.
 */
export const CAMPAIGN_SYSTEMS: CampaignSystem[] = ["ai_dialer", "neodove"];
