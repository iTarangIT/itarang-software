/**
 * Per-module usage, read from E-215's module_usage_daily.
 *
 * Answers "which parts of the CRM are actually used", which /operations/usage
 * could not previously say anything about — it knew how many people signed in
 * and for how long, but not where they went.
 *
 * AGGREGATE BY CONSTRUCTION. There is no user filter here and no way to add one,
 * because the table has no user_id. That is why this module needs none of the
 * machinery around it that the login history does: no read-audit, no MAX_ROWS
 * cap against bulk export, no 90/30-day expiry. There is nothing here to
 * protect, which was the point of designing it this way.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { HEARTBEAT_SECONDS } from "@/lib/usage/constants";

import {
  rollUpModuleDetail,
  rollUpModuleUsers,
  rollUpModules,
  type ModuleDayRaw,
  type ModuleDetail,
  type ModuleUsageRaw,
  type ModuleUsageRow,
  type ModuleUserRaw,
  type ModuleUserRow,
} from "./moduleUsageMath";

export type {
  ModuleDetail,
  ModuleUsageRow,
  ModuleUserRow,
} from "./moduleUsageMath";

export interface ModuleUsageView {
  rows: ModuleUsageRow[];
  /**
   * The window carried no rows at all. Ambiguous on purpose — it means either
   * "nobody used the CRM", "the heartbeat is off", or "E-215 is not applied
   * here" — and the page says all three rather than picking one.
   */
  empty: boolean;
  /**
   * The query itself failed, almost always a missing relation. Distinct from
   * `empty` so the page can tell "no data" from "no table".
   */
  unavailable: boolean;
}

/**
 * Roll up the last `days` days by module.
 *
 * NEVER THROWS, and that is deliberate rather than defensive habit. This is
 * called from getUsageView(), whose failure renders the whole page as an error
 * card — so if this threw on a missing relation, applying E-214 but not E-215
 * would take down a working login-history dashboard. A new migration must not be
 * able to break a page that was fine before it existed. The cost is that a
 * genuine query bug reads as "unavailable" instead of raising, which the
 * returned flag makes visible on screen.
 */
export async function getModuleUsage(days: number): Promise<ModuleUsageView> {
  try {
    // Bounded by `day`, an IST date, so the window edge lines up with the days
    // the rows were written under rather than sliding by 5h30.
    const result = await db.execute(sql`
      SELECT
        module,
        role_bucket,
        SUM(pings)::int    AS pings,
        SUM(sessions)::int AS sessions
      FROM module_usage_daily
      -- Cast to int, not a bare parameter: date minus an UNTYPED value is
      -- ambiguous to Postgres (date-integer, date-date and date-interval all
      -- exist) and resolves to "operator is not unique" at runtime.
      WHERE day > (NOW() AT TIME ZONE 'Asia/Kolkata')::date - ${days}::int
      GROUP BY module, role_bucket
    `);

    const raw = (result as unknown as Array<Record<string, unknown>>).map(
      (r): ModuleUsageRaw => ({
        module: String(r.module),
        role_bucket: String(r.role_bucket),
        pings: Number(r.pings ?? 0),
        sessions: Number(r.sessions ?? 0),
      }),
    );

    return {
      rows: rollUpModules(raw, HEARTBEAT_SECONDS),
      empty: raw.length === 0,
      unavailable: false,
    };
  } catch (e) {
    console.error("[ops] getModuleUsage failed:", e);
    // Still returns a full set of allow-list rows, all zeroed, so the table
    // keeps its shape and the page can explain itself instead of blanking.
    return {
      rows: rollUpModules([], HEARTBEAT_SECONDS),
      empty: true,
      unavailable: true,
    };
  }
}

export interface ModuleDetailView {
  detail: ModuleDetail;
  /** The query failed — almost always a missing relation. See getModuleUsage. */
  unavailable: boolean;
}

/**
 * One module's day-by-day breakdown, for the drill-down (E-215).
 *
 * STILL AGGREGATE. This is the same table, grouped one level finer — by day as
 * well as by bucket. It cannot name a user and no argument here could make it,
 * because module_usage_daily has no user id; the drill-down shows WHEN a module
 * was used and by which of the two role buckets, not by whom. That is the whole
 * reason this needs no read-audit, no row cap and no expiry, exactly as the
 * summary above does not.
 *
 * `module` reaches SQL as a bound parameter and is allow-listed upstream by
 * parseUsageFilters(), so an unknown value never gets this far.
 *
 * NEVER THROWS, for the same reason getModuleUsage does not: it is awaited
 * inside getUsageView(), and a drill-down failing must not take down a login
 * history that was working.
 */
export async function getModuleDetail(
  module: string,
  days: number,
): Promise<ModuleDetailView> {
  try {
    const result = await db.execute(sql`
      SELECT
        TO_CHAR(day, 'YYYY-MM-DD') AS day,
        role_bucket,
        SUM(pings)::int    AS pings,
        SUM(sessions)::int AS sessions
      FROM module_usage_daily
      WHERE module = ${module}::varchar
        -- Same bound and same cast as getModuleUsage, so the drill-down and the
        -- row it opened from can never describe different windows.
        AND day > (NOW() AT TIME ZONE 'Asia/Kolkata')::date - ${days}::int
      GROUP BY day, role_bucket
      ORDER BY day
    `);

    const raw = (result as unknown as Array<Record<string, unknown>>).map(
      (r): ModuleDayRaw => ({
        day: String(r.day),
        role_bucket: String(r.role_bucket),
        pings: Number(r.pings ?? 0),
        sessions: Number(r.sessions ?? 0),
      }),
    );

    return {
      detail: rollUpModuleDetail(module, raw, HEARTBEAT_SECONDS),
      unavailable: false,
    };
  } catch (e) {
    console.error("[ops] getModuleDetail failed:", e);
    return {
      detail: rollUpModuleDetail(module, [], HEARTBEAT_SECONDS),
      unavailable: true,
    };
  }
}

export interface ModuleUsersView {
  rows: ModuleUserRow[];
  /**
   * The query failed — on a database without E-216 applied, this is the normal
   * reading and the page says so rather than implying nobody used the module.
   */
  unavailable: boolean;
}

/**
 * Who used one module, from E-216's module_usage_user_daily.
 *
 * THE ONLY PER-PERSON MODULE READ IN THE CODEBASE. Everything E-215 said about
 * needing no read-audit and no retention applies to the AGGREGATE and stops
 * being true here: this names individuals, so the caller must record the view
 * (recordUsageView) exactly as the login history does, and runDailySnapshot()
 * prunes the underlying rows at 30 days.
 *
 * Returns only what the drill-down renders: who, the role at ping time, the
 * bucket, counts, and the last DAY. No path, no query, no sub-day timestamp —
 * none of which the table stores.
 *
 * NEVER THROWS, for the reason getModuleUsage does not: it is awaited inside
 * getUsageView(), and a database without E-216 must not take down a page that
 * worked before this migration existed.
 */
export async function getModuleUsers(
  module: string,
  days: number,
): Promise<ModuleUsersView> {
  try {
    const result = await db.execute(sql`
      SELECT
        m.user_id::text                       AS user_id,
        -- LEFT JOIN + COALESCE: a departed employee, or an auth user with no
        -- users row, must still appear. Dropping them would silently understate
        -- a module's usage and hide exactly the account worth asking about.
        COALESCE(NULLIF(u.name, ''), u.email, 'unknown') AS name,
        -- The most recent role seen, not an arbitrary one, so a mid-window role
        -- change reads as where the person ended up.
        (ARRAY_AGG(m.role_at_ping ORDER BY m.day DESC))[1] AS role_at_ping,
        (ARRAY_AGG(m.role_bucket  ORDER BY m.day DESC))[1] AS role_bucket,
        SUM(m.pings)::int                     AS pings,
        SUM(m.sessions)::int                  AS sessions,
        TO_CHAR(MAX(m.day), 'YYYY-MM-DD')     AS last_day,
        COUNT(DISTINCT m.day)::int            AS days_active
      FROM module_usage_user_daily m
      LEFT JOIN users u ON u.id = m.user_id
      WHERE m.module = ${module}::varchar
        -- Same bound and cast as getModuleUsage/getModuleDetail, so the three
        -- can never describe different windows.
        AND m.day > (NOW() AT TIME ZONE 'Asia/Kolkata')::date - ${days}::int
      GROUP BY m.user_id, u.name, u.email
      ORDER BY SUM(m.pings) DESC
    `);

    const raw = (result as unknown as Array<Record<string, unknown>>).map(
      (r): ModuleUserRaw => ({
        user_id: String(r.user_id),
        name: String(r.name ?? "unknown"),
        role_at_ping: r.role_at_ping == null ? null : String(r.role_at_ping),
        role_bucket: String(r.role_bucket ?? "internal"),
        pings: Number(r.pings ?? 0),
        sessions: Number(r.sessions ?? 0),
        last_day: r.last_day == null ? null : String(r.last_day),
        days_active: Number(r.days_active ?? 0),
      }),
    );

    return {
      rows: rollUpModuleUsers(raw, HEARTBEAT_SECONDS),
      unavailable: false,
    };
  } catch (e) {
    console.error("[ops] getModuleUsers failed:", e);
    return { rows: [], unavailable: true };
  }
}
