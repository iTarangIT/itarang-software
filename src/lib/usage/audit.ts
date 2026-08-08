/**
 * Watching the watchers.
 *
 * /operations/usage is the only surface in this console that names individual
 * people. The strongest single thing that makes collecting that data defensible
 * is that looking at it is itself recorded — so the answer to "who has been
 * reading my session history?" is a query rather than a shrug.
 *
 * WHAT IS AUDITED, AND WHAT IS NOT. Only the PER-PERSON view: the login history
 * table, and any view narrowed to a single user. The aggregate tiles are not
 * audited — they name nobody, and auditing them would bury the rows that matter
 * under a stream of rows that do not, which is how an audit trail becomes noise
 * that everybody ignores.
 *
 * DELIBERATELY NOT GATED BY USAGE_TRACKING. That switch stops recording
 * EMPLOYEES. It must not also stop recording who reads employee data — if
 * anything, a period when collection is disabled is exactly when you would want
 * to know who was still reading the archive. This looks like an omission, so it
 * is written down here.
 */

import { sql } from "drizzle-orm";

import { generateId } from "@/lib/api-utils";
import { db } from "@/lib/db";

/** entity_type for every row this module writes. */
const ENTITY_TYPE = "usage_analytics";

/**
 * Record that somebody opened the per-person usage view.
 *
 * DEDUPED ON (viewer, entity_id) PER HOUR, not on viewer alone. The distinction
 * matters: the page auto-refreshes every 60 seconds, so a viewer-only dedupe
 * would be needed to stop 60 rows an hour — but it would also mean that
 * inspecting person A and then person B in the same hour recorded only the
 * first. The trail would then say somebody looked at *something* while omitting
 * *whom*, which is the only part worth having.
 *
 * `entity_id` is the user being inspected, or 'all' for the unfiltered
 * per-person list.
 *
 * Never throws. An audit failure must not take down the page — but it IS
 * logged, because a silently failing audit trail is worse than none at all.
 */
export async function recordUsageView(params: {
  viewerId: string;
  /** The filtered user id, or null for the unfiltered per-person view. */
  subjectId?: string | null;
  /** Window in days, recorded as context on the row. */
  days: number;
  /** Where it was read from — the page or the JSON API. */
  surface: "page" | "api";
}): Promise<void> {
  const entityId = params.subjectId ?? "all";

  try {
    const id = await generateId("AUDIT");
    await db.execute(sql`
      INSERT INTO audit_logs (id, entity_type, entity_id, action, performed_by, new_data)
      SELECT ${id}, ${ENTITY_TYPE}, ${entityId}, 'view', ${params.viewerId}::uuid,
             ${JSON.stringify({ days: params.days, surface: params.surface })}::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM audit_logs
        WHERE entity_type = ${ENTITY_TYPE}
          AND entity_id   = ${entityId}
          AND performed_by = ${params.viewerId}::uuid
          AND created_at  > NOW() - INTERVAL '1 hour'
      )
    `);
  } catch (e) {
    console.error("[usage] recordUsageView failed:", e);
  }
}
