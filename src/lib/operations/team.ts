/**
 * The read model behind /operations/team.
 *
 * SCOPE. This is licence and capacity monitoring — how many seats are in use,
 * how many accounts were provisioned and forgotten, whether system activity has
 * collapsed. It is not per-person productivity tracking, and the shape of the
 * data reflects that:
 *
 *   · the sign-in buckets are aggregate counts, computed by the collector from
 *     Supabase and stored as six numbers — never one row per person;
 *   · the by-role and top-actor breakdowns are read LIVE from audit_logs at
 *     render time and never written to ops_metric_samples, so there is no
 *     30-day per-employee activity history accumulating anywhere.
 *
 * `audit_logs.performed_by` is written by ~36 API routes, so it measures
 * write-shaped work only. Somebody who spent the day reading dashboards shows
 * up as zero, which is why nothing here should be read as effort.
 *
 * NOT THE ONLY USAGE SURFACE ANY MORE. Per-person sign-in history and session
 * duration live on /operations/usage (src/lib/operations/usage.ts, E-214) under
 * their own role set and their own retention. This module deliberately stays
 * aggregate — do not add per-person reads here; the split is the point. See
 * collectors/team.ts for what the E-214 work did and did not change.
 *
 * The two pages report DIFFERENT active-user numbers on purpose, from different
 * sources: this one buckets Supabase's auth.users.last_sign_in_at (sign-in
 * RECENCY, including people who have not opened the CRM in weeks but whose token
 * still refreshes), while /operations/usage counts observed sessions. Neither is
 * wrong; each page states which it is showing, because two unexplained
 * "active users" figures would train people to trust neither.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

import { getMetric, type MetricDef } from "./registry";
import { bySourceKey, latestSamples } from "./samples";

const SOURCE = "team:all";

const TEAM_METRICS = [
  "team.active_users_24h",
  "team.active_users_7d",
  "team.active_users_30d",
  "team.never_logged_in",
  "team.inactive_30d",
  "team.actions_24h",
];

export interface TeamMetricRow {
  key: string;
  label: string;
  unit: MetricDef["unit"];
  help?: string;
  value: number | null;
  /** Set when the collector recorded a reason instead of a number. */
  unavailable: string | null;
  age_minutes: number | null;
}

export interface RoleActivity {
  role: string;
  actors: number;
  actions: number;
}

export interface TopActor {
  name: string;
  role: string;
  actions: number;
}

export interface TeamView {
  metrics: TeamMetricRow[];
  by_role: RoleActivity[];
  top_actors: TopActor[];
  /** Total audited actions in the live window, for context on the breakdowns. */
  actions_30d: number;
  never_collected: boolean;
}

export async function getTeamView(): Promise<TeamView> {
  const [samples, byRoleRows, topActorRows, totalRows] = await Promise.all([
    latestSamples(TEAM_METRICS, { maxAgeHours: 48 }),

    // Actions by role over 30 days. LEFT JOIN so audit rows whose actor was
    // deleted still count somewhere rather than vanishing from the total.
    db.execute(sql`
      SELECT
        COALESCE(u.role, 'unknown')          AS role,
        COUNT(DISTINCT a.performed_by)::int  AS actors,
        COUNT(*)::int                        AS actions
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.performed_by
      WHERE a.created_at > NOW() - INTERVAL '30 days'
      GROUP BY COALESCE(u.role, 'unknown')
      ORDER BY actions DESC
    `),

    // Top actors. Capped at 10 and deliberately name+count only — no per-action
    // detail, no drill-down. Enough to answer "is one integration account doing
    // all the writing?", which is the operational question.
    db.execute(sql`
      SELECT
        COALESCE(u.name, 'unknown')  AS name,
        COALESCE(u.role, 'unknown')  AS role,
        COUNT(*)::int                AS actions
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.performed_by
      WHERE a.created_at > NOW() - INTERVAL '30 days'
      GROUP BY COALESCE(u.name, 'unknown'), COALESCE(u.role, 'unknown')
      ORDER BY actions DESC
      LIMIT 10
    `),

    db.execute(sql`
      SELECT COUNT(*)::int AS n FROM audit_logs
      WHERE created_at > NOW() - INTERVAL '30 days'
    `),
  ]);

  const index = bySourceKey(samples);

  const metrics = TEAM_METRICS.map((key): TeamMetricRow | null => {
    const def = getMetric(key);
    if (!def) return null;
    const sample = index.get(`${key}|${SOURCE}`);
    return {
      key,
      label: def.label,
      unit: def.unit,
      help: def.help,
      value: sample?.value_num ?? null,
      unavailable:
        sample?.value_num == null && sample?.value_text ? sample.value_text : null,
      age_minutes: sample?.age_minutes ?? null,
    };
  }).filter((r): r is TeamMetricRow => r !== null);

  const rows = <T,>(r: unknown) => r as unknown as Array<Record<string, unknown>> as T[];

  return {
    metrics,
    by_role: rows<Record<string, unknown>>(byRoleRows).map((r) => ({
      role: String(r.role),
      actors: Number(r.actors ?? 0),
      actions: Number(r.actions ?? 0),
    })),
    top_actors: rows<Record<string, unknown>>(topActorRows).map((r) => ({
      name: String(r.name),
      role: String(r.role),
      actions: Number(r.actions ?? 0),
    })),
    actions_30d: Number(
      (totalRows as unknown as Array<Record<string, unknown>>)[0]?.n ?? 0,
    ),
    never_collected: samples.length === 0,
  };
}
