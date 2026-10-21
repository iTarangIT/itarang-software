// HANDOVER-A31 — the lead's effective door in SQL: the stamped E-314
// source_door, else the door its legacy `source` implies (LEGACY_SOURCE_DOOR),
// else NULL. The same rule as effectiveDoor() in leadSourceVocab.ts, which the
// /leads "Lead source" column shows — so the filter and the column agree.
//
// source_door is read through to_jsonb: it is not in schema.ts, and a database
// without E-314 must still serve the filter (every lead falls back to its
// legacy source) rather than 500 the list.
import { sql, type SQL } from "drizzle-orm";

import { LEGACY_SOURCE_DOOR } from "./leadSourceVocab";

/** `dl` = the dealer_leads alias. */
export function effectiveDoorSql(dl: SQL = sql`dl`): SQL {
    const whens = Object.entries(LEGACY_SOURCE_DOOR).map(
        ([legacy, door]) => sql`WHEN ${legacy}::text THEN ${door}::text`,
    );
    return sql`COALESCE(to_jsonb(${dl}) ->> 'source_door', (CASE ${dl}.source ${sql.join(whens, sql` `)} END))`;
}
