/**
 * Tracker ID 155 — the owner-scope predicate as SQL. No db import (pure
 * drizzle `sql` fragments), so it is unit-testable and safe in any builder.
 *
 * Without a team it renders EXACTLY the old `<col> = <self>` clause, so a
 * team member's (or a non-manager's) queries are byte-for-byte unchanged —
 * the WhatsApp Assistant's tabFilter golden test relies on that.
 */
import { sql, type SQL } from "drizzle-orm";
import { ownerScopeIds } from "./teamRules";

/** `<col> = self`, or `<col> IN (self, ...directReports)` for a manager. */
export function ownerScopeSql(col: SQL, selfId: string, teamMemberIds?: readonly string[] | null): SQL {
    const ids = ownerScopeIds(selfId, teamMemberIds);
    if (ids.length === 1) return sql`${col} = ${selfId}`;
    return sql`${col} IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
    )})`;
}
