/**
 * The SQL twin of engagedSeconds() in usageMath.ts.
 *
 * Session duration is computed in two places — the collector (which rolls it up
 * into p50/p90 samples) and the read model (which renders per-session figures) —
 * and both must agree, or the tile and the table below it will quietly disagree
 * about the same sessions. Defining the expression once is the only way to stop
 * that drifting.
 *
 * It cannot be shared with the TypeScript version: one runs in Postgres over a
 * whole table, the other in Node over a single row. So they are twins, not one
 * function — and a comment on each points at the other.
 */

import { sql } from "drizzle-orm";

import { HEARTBEAT_SECONDS } from "@/lib/usage/constants";

/**
 * Engaged seconds for a `user_activity_sessions` row.
 *
 *   LEAST(ping_count * HEARTBEAT, wall_clock_span + HEARTBEAT)
 *
 * Ping-derived, not span-derived, and that IS the point: a laptop that slept for
 * three hours with a tab open sends two heartbeats, so it reports 600s rather
 * than 10,800s. The `+ HEARTBEAT` gives a single-ping session credit for one
 * interval instead of zero; the LEAST() caps at wall clock so a client with a
 * skewed clock, or one pinging in a loop, cannot inflate its own total.
 *
 * Assumes the columns are in scope unqualified (`ping_count`, `started_at`,
 * `last_seen_at`), which is true for every query that selects from
 * user_activity_sessions without aliasing it.
 */
export const ENGAGED_SECONDS_SQL = sql`
  LEAST(
    ping_count * ${HEARTBEAT_SECONDS},
    EXTRACT(EPOCH FROM (last_seen_at - started_at)) + ${HEARTBEAT_SECONDS}
  )
`;
