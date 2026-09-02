/**
 * The pure half of the per-module read model (E-215).
 *
 * Split from moduleUsage.ts for the reason usageMath.ts is split from usage.ts:
 * @/lib/db throws at import time without DATABASE_URL, so anything importing it
 * cannot be unit tested. Everything here is a pure function over plain data and
 * is covered by __tests__/moduleUsageMath.test.ts.
 */

import { MODULES, MODULE_OTHER, type ModuleName } from "@/lib/usage/constants";

/**
 * Display names. Kept beside the roll-up rather than in the page so the JSON API
 * and the table cannot disagree about what `asm` is called.
 *
 * `other` is deliberately worded as a diagnostic rather than a category — when it
 * climbs, the answer is usually that a module shipped and MODULES was not
 * updated, and the label should say so to whoever is looking at the table.
 */
export const MODULE_LABELS: Record<string, string> = {
  nbfc: "NBFC Portal",
  "inside-sales": "Inside Sales",
  "dealer-portal": "Dealer Portal",
  ceo: "CEO Dashboard",
  "sales-head": "Sales Head",
  asm: "ASM",
  [MODULE_OTHER]: "Other / untracked",
};

export function moduleLabel(module: string): string {
  return MODULE_LABELS[module] ?? module;
}

/** One row of module_usage_daily, as it comes back from SQL. */
export interface ModuleUsageRaw {
  module: string;
  role_bucket: string;
  pings: number;
  sessions: number;
}

export interface ModuleUsageRow {
  module: ModuleName | string;
  label: string;
  /** Heartbeats across the window, both buckets. */
  pings: number;
  /** Distinct session-days, both buckets. */
  sessions: number;
  internal_sessions: number;
  external_sessions: number;
  /** pings x heartbeat interval, in minutes. Coarse by construction. */
  minutes: number;
  /** Fraction of all tracked pings in the window, 0-1. */
  share: number;
  /** No row at all in the window — not the same as zero, see below. */
  never_seen: boolean;
}

/**
 * Fold the per-bucket rows into one row per module.
 *
 * EVERY MODULE IN THE ALLOW-LIST GETS A ROW, whether or not the window contains
 * data for it. This is the single most important behaviour in this file: the
 * question that motivated E-215 is "is anyone using /asm", and the answer
 * "nobody, all month" is only visible if an absent module still renders. A
 * roll-up that emitted rows only for what it found would answer that question by
 * omitting it.
 *
 * `never_seen` distinguishes the two zeroes so the page can too — a module with
 * no rows may genuinely be unused, or E-215 may simply not be applied on this
 * database yet, and those must not look identical.
 *
 * `other` appears only when present, since a permanent empty 'Other' row is
 * noise; when it does appear it is worth reading.
 */
export function rollUpModules(
  raw: ModuleUsageRaw[],
  heartbeatSeconds = 300,
): ModuleUsageRow[] {
  const acc = new Map<
    string,
    { pings: number; sessions: number; internal: number; external: number }
  >();

  const bump = (module: string) => {
    let hit = acc.get(module);
    if (!hit) {
      hit = { pings: 0, sessions: 0, internal: 0, external: 0 };
      acc.set(module, hit);
    }
    return hit;
  };

  for (const row of raw) {
    const pings = Number(row.pings);
    const sessions = Number(row.sessions);
    const hit = bump(String(row.module));
    // Non-finite values would poison every downstream total and the share
    // denominator with NaN, which renders as "—" everywhere and looks like an
    // outage rather than one bad row.
    hit.pings += Number.isFinite(pings) ? pings : 0;
    hit.sessions += Number.isFinite(sessions) ? sessions : 0;
    if (row.role_bucket === "external") {
      hit.external += Number.isFinite(sessions) ? sessions : 0;
    } else {
      hit.internal += Number.isFinite(sessions) ? sessions : 0;
    }
  }

  // Allow-list first (so an unused module still renders), then 'other' if seen.
  const keys: string[] = [...MODULES];
  if (acc.has(MODULE_OTHER)) keys.push(MODULE_OTHER);

  const totalPings = [...acc.values()].reduce((sum, v) => sum + v.pings, 0);

  const rows = keys.map((module): ModuleUsageRow => {
    const hit = acc.get(module);
    const pings = hit?.pings ?? 0;
    return {
      module,
      label: moduleLabel(module),
      pings,
      sessions: hit?.sessions ?? 0,
      internal_sessions: hit?.internal ?? 0,
      external_sessions: hit?.external ?? 0,
      minutes: Math.round((pings * heartbeatSeconds) / 60),
      // Guarded, not because a zero total is exotic but because it is the
      // NORMAL state before the heartbeat is switched on, and 0/0 would put
      // NaN% into every row on the first day anyone opens the page.
      share: totalPings > 0 ? pings / totalPings : 0,
      never_seen: hit === undefined,
    };
  });

  // Busiest first, but the allow-list order breaks ties — so an all-zero table
  // (heartbeat off, or E-215 unapplied) renders in a stable, meaningful order
  // rather than whatever Map iteration happened to produce.
  return rows.sort((a, b) => b.pings - a.pings);
}

/** One person's rolled-up rows from module_usage_user_daily (E-216). */
export interface ModuleUserRaw {
  user_id: string;
  name: string;
  role_at_ping: string | null;
  role_bucket: string;
  pings: number;
  sessions: number;
  last_day: string | null;
  days_active: number;
}

export interface ModuleUserRow {
  user_id: string;
  name: string;
  role: string;
  bucket: "internal" | "external";
  pings: number;
  sessions: number;
  minutes: number;
  last_day: string | null;
  days_active: number;
}

/**
 * Shape the per-user rows for the drill-down (E-216).
 *
 * Busiest first, because "who is actually in this module" is the question, and
 * a name at the top of a list is the answer to it.
 *
 * Does NOT invent anyone. A module with no per-user rows returns an empty array
 * and the page says so — it must never fall back to guessing a user from a
 * session, which is what module_visit_keys would do and get wrong.
 */
export function rollUpModuleUsers(
  raw: ModuleUserRaw[],
  heartbeatSeconds = 300,
): ModuleUserRow[] {
  return raw
    .map((r): ModuleUserRow => {
      const pings = Number(r.pings);
      const sessions = Number(r.sessions);
      const safePings = Number.isFinite(pings) ? pings : 0;
      return {
        user_id: String(r.user_id),
        // The SQL COALESCEs to 'unknown'; this guards the empty string too, so
        // a blank name never renders as a nameless row the reader cannot act on.
        name: r.name?.trim() ? r.name : "unknown",
        // 'unknown' rather than '—': the role was genuinely not resolved at ping
        // time, which is different from us declining to show it.
        role: r.role_at_ping?.trim() ? r.role_at_ping : "unknown",
        bucket: r.role_bucket === "external" ? "external" : "internal",
        pings: safePings,
        sessions: Number.isFinite(sessions) ? sessions : 0,
        minutes: Math.round((safePings * heartbeatSeconds) / 60),
        last_day: r.last_day ?? null,
        days_active: Number.isFinite(Number(r.days_active))
          ? Number(r.days_active)
          : 0,
      };
    })
    .sort((a, b) => b.pings - a.pings || a.name.localeCompare(b.name));
}

/** One (day, role_bucket) row of module_usage_daily for a single module. */
export interface ModuleDayRaw {
  day: string;
  role_bucket: string;
  pings: number;
  sessions: number;
}

export interface ModuleDayPoint {
  /** YYYY-MM-DD, IST — the same day key the rows were written under. */
  day: string;
  pings: number;
  sessions: number;
  internal_sessions: number;
  external_sessions: number;
  minutes: number;
}

export interface ModuleDetail {
  module: string;
  label: string;
  /** One entry per day that carried data, oldest first. Gaps are NOT filled. */
  days: ModuleDayPoint[];
  pings: number;
  sessions: number;
  internal_sessions: number;
  external_sessions: number;
  minutes: number;
  /** Earliest and latest day with any activity, or null when there is none. */
  first_day: string | null;
  /** Day granularity — the table stores no finer timestamp. */
  last_day: string | null;
  /** Nothing at all in the window. Distinct from `unavailable` upstream. */
  empty: boolean;
}

/**
 * Fold one module's per-day rows into the drill-down view model.
 *
 * DELIBERATELY DOES NOT FILL GAPS, unlike fillLoginDays() next door. The login
 * trend is a bar chart where a missing day must read as an explicit zero or the
 * chart lies about its own x-axis. This is a table of days that had activity,
 * and inventing rows for the other 25 days of a 30-day window would bury the
 * three that matter. The caller renders the chart from `days` and can zero-fill
 * there if it ever needs to.
 *
 * `minutes` is derived per day rather than by dividing the total, so the column
 * sums to the header figure instead of drifting by a rounding step per row.
 *
 * Pure and total: an empty input is a valid module that nobody has opened, which
 * is a real answer and renders as such.
 */
export function rollUpModuleDetail(
  module: string,
  raw: ModuleDayRaw[],
  heartbeatSeconds = 300,
): ModuleDetail {
  const byDay = new Map<string, ModuleDayPoint>();

  for (const row of raw) {
    const day = String(row.day);
    const pings = Number(row.pings);
    const sessions = Number(row.sessions);
    // Same guard as rollUpModules: one non-finite value would turn every total
    // below into NaN, which renders as "—" and reads as an outage.
    const safePings = Number.isFinite(pings) ? pings : 0;
    const safeSessions = Number.isFinite(sessions) ? sessions : 0;

    let point = byDay.get(day);
    if (!point) {
      point = {
        day,
        pings: 0,
        sessions: 0,
        internal_sessions: 0,
        external_sessions: 0,
        minutes: 0,
      };
      byDay.set(day, point);
    }

    point.pings += safePings;
    point.sessions += safeSessions;
    if (row.role_bucket === "external") point.external_sessions += safeSessions;
    else point.internal_sessions += safeSessions;
    point.minutes = Math.round((point.pings * heartbeatSeconds) / 60);
  }

  // Oldest first: this feeds a left-to-right time axis, and the summary table
  // above is the place for busiest-first ordering.
  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));

  const sum = (pick: (p: ModuleDayPoint) => number) =>
    days.reduce((total, p) => total + pick(p), 0);

  const pings = sum((p) => p.pings);

  return {
    module,
    label: moduleLabel(module),
    days,
    pings,
    sessions: sum((p) => p.sessions),
    internal_sessions: sum((p) => p.internal_sessions),
    external_sessions: sum((p) => p.external_sessions),
    minutes: Math.round((pings * heartbeatSeconds) / 60),
    first_day: days[0]?.day ?? null,
    last_day: days[days.length - 1]?.day ?? null,
    empty: days.length === 0,
  };
}
