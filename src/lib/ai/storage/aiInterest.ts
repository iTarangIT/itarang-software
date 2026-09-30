// AI calls and lead temperature (tracker ID 64, handover P0-10).
//
// Once a lead has an owner, only the owner's work changes its Hot / Warm / Cold:
// an AI call's band feeds temperature for UNOWNED, OPEN leads only. Without
// this a rep's Hot lead flipped to Cold after an AI re-dial. The guard is in SQL
// so it reads the owner as it is at write time, not as the call's opening SELECT
// saw it minutes earlier.

import { sql, type SQL } from "drizzle-orm";
import { dealerLeads } from "@/lib/db/schema";

export function aiInterestLevelSql(next: string | null): SQL {
    return sql`CASE
        WHEN ${dealerLeads.current_owner_id} IS NULL
         AND COALESCE(${dealerLeads.lead_status}, '') NOT IN ('Converted', 'Lost')
        THEN ${next}
        ELSE ${dealerLeads.interest_level}
    END`;
}
