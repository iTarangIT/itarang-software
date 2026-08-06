/**
 * Error volume, from the log lines the agents forwarded.
 *
 * Two numbers, and the second is the one that matters. Raw error COUNT is
 * dominated by whichever bug is currently in a loop; DISTINCT fingerprints tell
 * you whether that is one problem shouting or ten problems starting. A deploy
 * that breaks a new code path shows up as distinct_errors climbing even when the
 * total is flat.
 *
 * Reads ops_log_events, which the ingest route writes. Nothing here parses a log
 * file — the agent already did that, on the box, where the file is.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

import type { CollectedSample, OpsCollector } from "./types";
import { MINUTE } from "./types";

export const logsCollector: OpsCollector = {
  id: "logs.errors",
  label: "Error volume (1h)",
  intervalMs: 5 * MINUTE,

  async run(): Promise<CollectedSample[]> {
    // One pass over the last hour for both numbers. The
    // (level, logged_at DESC) index from E-210 covers this exactly.
    const rows = (await db.execute(sql`
      SELECT
        COUNT(*)                    AS total,
        COUNT(DISTINCT fingerprint) AS distinct_count
      FROM ops_log_events
      WHERE level = 'error'
        AND logged_at > NOW() - INTERVAL '1 hour'
    `)) as unknown as Array<Record<string, unknown>>;

    const row = rows?.[0];
    const total = Number(row?.total ?? 0);
    const distinct = Number(row?.distinct_count ?? 0);

    return [
      {
        metric_key: "logs.error_count_1h",
        source: "logs:all",
        value_num: Number.isFinite(total) ? total : 0,
      },
      {
        metric_key: "logs.distinct_errors_1h",
        source: "logs:all",
        value_num: Number.isFinite(distinct) ? distinct : 0,
      },
    ];
  },
};
