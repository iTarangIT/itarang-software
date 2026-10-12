// "Finalised, not Won" (tracker ID 75.4) — ONE predicate for the admin alert
// panel (src/lib/admin/dashboard.ts) and the reps' own queue chip (ISR
// "My open", ASM "My visits"), so the two lists can never disagree about which
// leads qualify.
//
//   lead_status = Commercials_Finalised (so not Won / Converted yet), active,
//   with a quote the dealer APPROVED that cleared our own approval gate and
//   was not withdrawn.
//
// The admin panel adds an age floor — the CEO card's rule (saidYesNotWon.ts,
// ID 85 time limit said_yes_not_won): more than N working days (Mon–Sat,
// active holidays off) since the dealer's LATEST yes, so the card's "over
// limit" and the panel list the same leads. The rep's chip has none — their
// list is "approved, go mark it Won" from the moment the dealer says yes.
//
// Reads `dealer_leads dl`. Server-side SQL only (drizzle `sql`, no db import).

import { sql, type SQL } from "drizzle-orm";
import { workingDaysSinceSql } from "@/lib/calendar/holidays";

/** Query-string flag for the reps' queue chip (`?finalised=1`). */
export const FINALISED_NOT_WON_PARAM = "finalised";

/** When the dealer last said yes on a live quote (the CEO card's clock). */
export const DEALER_YES_AT_SQL = sql`(SELECT MAX(c.dealer_decision_at) FROM dealer_lead_commercials c
    WHERE c.dealer_lead_id = dl.id
      AND c.dealer_decision = 'approved'
      AND COALESCE(c.approval_status, 'approved') = 'approved'
      AND c.withdrawn_at IS NULL)`;

export function finalisedNotWonSql(opts: { overWorkingDays?: number } = {}): SQL {
    const days = opts.overWorkingDays != null && opts.overWorkingDays >= 0 ? Math.floor(opts.overWorkingDays) : null;
    const aged =
        days != null
            ? sql`
    AND ${workingDaysSinceSql(DEALER_YES_AT_SQL)} > ${sql.raw(String(days))}`
            : sql``;
    // ID 169 (Kartik, 10 Oct): a lead whose Mark Won was undone is not
    // "dealer said yes, not marked Won" — it was marked and taken back on
    // purpose. to_jsonb: won_undone_at is E-333.
    return sql`dl.lead_status = 'Commercials_Finalised'
    AND dl.is_active IS NOT FALSE
    AND NOT EXISTS (SELECT 1 FROM dealer_lead_status_history uh
        WHERE uh.dealer_lead_id = dl.id
          AND uh.to_status = 'Won'
          AND to_jsonb(uh) ->> 'won_undone_at' IS NOT NULL)
    AND EXISTS (SELECT 1 FROM dealer_lead_commercials c
        WHERE c.dealer_lead_id = dl.id
          AND c.dealer_decision = 'approved'
          AND COALESCE(c.approval_status, 'approved') = 'approved'
          AND c.withdrawn_at IS NULL)${aged}`;
}
