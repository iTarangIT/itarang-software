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
