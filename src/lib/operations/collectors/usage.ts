/**
 * CRM usage — what the team actually does with the system.
 *
 * Distinct from team.ts, which asks Supabase how RECENTLY each account signed in
 * (licence and capacity). This one reads our own E-214 tables and asks how the
 * CRM is being used. The two will not agree, and should not: see the note in
 * team.ts and §8 of docs/OPERATIONS_RUNBOOK.md.
 *
 * THE INVARIANT THIS COLLECTOR EXISTS TO KEEP: it writes AGGREGATES ONLY, under
 * the single source "usage:all". No per-person row is ever written to
 * ops_metric_samples or ops_daily_snapshots — those are never pruned, and a
 * per-employee history accumulating in them forever is the exact thing
 * collectors/team.ts refused to build. Per-person data lives in the E-214 tables,
 * which expire. A test in __tests__ pins the sample count and the source.
 *
 * PHASE 1 writes one metric: logins. The session-derived metrics (DAU/WAU/MAU,
 * session length) need user_activity_sessions, which the heartbeat fills, and
 * that ships only after the staff notice has gone out.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

import type { CollectedSample, OpsCollector } from "./types";
import { MINUTE } from "./types";

/**
 * One source for every sample. Not "usage:<user_id>" — see the invariant above;
 * the source column is exactly where a per-person leak would appear.
 */
const SOURCE = "usage:all";

export const usageCollector: OpsCollector = {
  id: "usage.activity",
  label: "CRM usage — logins and active users",
  // Logins move on a day scale, and the finest thing this will ever measure is
  // concurrent sessions. 15 minutes is 36 points across a working day, which is
  // already more than a tile-width sparkline can resolve.
  intervalMs: 15 * MINUTE,
  timeoutMs: 15_000,

  async run(): Promise<CollectedSample[]> {
    // allSettled even with one query, so adding the session metrics in Phase 2
    // cannot make a single failure cost the others — the same reasoning as
    // team.ts, applied before it can bite rather than after.
    const [loginsResult] = await Promise.allSettled([
      db.execute(sql`
        SELECT COUNT(*)::int AS n FROM user_login_events
        WHERE occurred_at > NOW() - INTERVAL '24 hours'
      `) as unknown as Promise<Array<Record<string, unknown>>>,
    ]);

    const samples: CollectedSample[] = [];

    if (loginsResult.status === "fulfilled") {
      const logins = Number(loginsResult.value?.[0]?.n ?? 0);
      samples.push({
        metric_key: "usage.logins_24h",
        source: SOURCE,
        value_num: Number.isFinite(logins) ? logins : 0,
      });
    }
    // A rejection is left to speak for itself: the run records zero samples, the
    // tile goes stale rather than reporting a confident zero, and
    // /operations/jobs shows the failure. Writing 0 on error would be a lie in
    // the one direction that looks healthy.

    return samples;
  },
};
