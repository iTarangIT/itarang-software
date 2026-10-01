// "Finalised, not Won" (tracker ID 75.4) — ONE predicate for the admin alert
// panel (src/lib/admin/dashboard.ts) and the reps' own queue chip (ISR
// "My open", ASM "My visits"), so the two lists can never disagree about which
// leads qualify.
//
//   lead_status = Commercials_Finalised (so not Won / Converted yet), active,
//   with a quote the dealer APPROVED that cleared our own approval gate and
//   was not withdrawn.
//
// The admin panel adds an age floor (the dealer approved 2+ days ago: nobody
// pressed Mark Won); the rep's chip has none — their list is "approved, go
// mark it Won" from the moment the dealer says yes.
//
// Reads `dealer_leads dl`. Server-side SQL only (drizzle `sql`, no db import).

import { sql, type SQL } from "drizzle-orm";

/** Query-string flag for the reps' queue chip (`?finalised=1`). */
export const FINALISED_NOT_WON_PARAM = "finalised";

export function finalisedNotWonSql(opts: { minAgeDays?: number } = {}): SQL {
    const days = opts.minAgeDays && opts.minAgeDays > 0 ? Math.floor(opts.minAgeDays) : 0;
    const aged = days
        ? sql`
          AND c.dealer_decision_at < NOW() - INTERVAL '${sql.raw(String(days))} days'`
        : sql``;
    return sql`dl.lead_status = 'Commercials_Finalised'
    AND dl.is_active IS NOT FALSE
    AND EXISTS (SELECT 1 FROM dealer_lead_commercials c
        WHERE c.dealer_lead_id = dl.id
          AND c.dealer_decision = 'approved'
          AND COALESCE(c.approval_status, 'approved') = 'approved'
          AND c.withdrawn_at IS NULL${aged})`;
}
