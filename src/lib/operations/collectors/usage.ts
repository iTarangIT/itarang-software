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
import { usageTrackingEnabled } from "@/lib/usage/track";

import { buildUsageSamples, numFrom } from "../usageSamples";
import { ENGAGED_SECONDS_SQL } from "../usageSql";
import type { CollectedSample, OpsCollector } from "./types";
import { MINUTE } from "./types";

const rows = (query: ReturnType<typeof sql>) =>
  db.execute(query) as unknown as Promise<Array<Record<string, unknown>>>;

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
    // The kill switch stops COLLECTION as well as writing. Emitting zeros here
    // instead would be actively harmful: with tracking off, sessions stop being
    // written, WAU decays to 0 within a week, and usage.wau's warn:1 fires — the
    // kill switch would page the tech team about itself. No samples means the
    // tiles go stale, which severityFor() reports as "unknown" and never green.
    if (!usageTrackingEnabled()) return [];

    // allSettled, not all: a broken half must cost only itself. Same discipline
    // as team.ts. Every result is unwrapped by numFrom(), which returns null —
    // never 0 — on rejection, so a failure can never be mistaken for a reading.
    const [logins, actives, sessions24h, activeNow, durations] =
      await Promise.allSettled([
        rows(sql`
          SELECT COUNT(*)::int AS n FROM user_login_events
          WHERE occurred_at > NOW() - INTERVAL '24 hours'
        `),

        // DAU/WAU/MAU in one pass — three windows over the same index scan.
        rows(sql`
          SELECT
            COUNT(DISTINCT user_id) FILTER (WHERE last_seen_at > NOW() - INTERVAL '1 day')::int   AS dau,
            COUNT(DISTINCT user_id) FILTER (WHERE last_seen_at > NOW() - INTERVAL '7 days')::int  AS wau,
            COUNT(DISTINCT user_id) FILTER (WHERE last_seen_at > NOW() - INTERVAL '30 days')::int AS mau
          FROM user_activity_sessions
          WHERE last_seen_at > NOW() - INTERVAL '30 days'
        `),

        rows(sql`
          SELECT COUNT(*)::int AS n FROM user_activity_sessions
          WHERE started_at > NOW() - INTERVAL '24 hours'
        `),

        // Two heartbeats plus slack, so a session is "active now" only while it
        // is genuinely still pinging.
        rows(sql`
          SELECT COUNT(*)::int AS n FROM user_activity_sessions
          WHERE last_seen_at > NOW() - INTERVAL '11 minutes'
        `),

        // Only sessions that have ALREADY FINISHED. Including in-flight ones
        // would measure everyone's morning-so-far: a collector running at 11:00
        // would report a p50 of nine minutes and it would look like a real
        // finding rather than an artefact of when the query ran.
        rows(sql`
          SELECT
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY engaged) / 60 AS p50,
            PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY engaged) / 60 AS p90
          FROM (
            SELECT ${ENGAGED_SECONDS_SQL} AS engaged
            FROM user_activity_sessions
            WHERE started_at   > NOW() - INTERVAL '24 hours'
              AND last_seen_at < NOW() - INTERVAL '15 minutes'
          ) finished
        `),
      ]);

    // Shaping happens in a db-free module so the aggregate-only invariant can be
    // tested without a database — see usageSamples.ts for why that matters.
    return buildUsageSamples({
      "usage.logins_24h": numFrom(logins, "n"),
      "usage.dau": numFrom(actives, "dau"),
      "usage.wau": numFrom(actives, "wau"),
      "usage.mau": numFrom(actives, "mau"),
      "usage.sessions_24h": numFrom(sessions24h, "n"),
      "usage.active_sessions": numFrom(activeNow, "n"),
      "usage.session_minutes_p50": numFrom(durations, "p50"),
      "usage.session_minutes_p90": numFrom(durations, "p90"),
    });
  },
};
