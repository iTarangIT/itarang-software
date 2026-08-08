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
  rollUpModules,
  type ModuleUsageRaw,
  type ModuleUsageRow,
} from "./moduleUsageMath";

export type { ModuleUsageRow } from "./moduleUsageMath";

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
