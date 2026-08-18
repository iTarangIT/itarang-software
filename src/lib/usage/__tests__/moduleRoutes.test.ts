import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MODULES, moduleFromPath } from "../constants";

/**
 * Does every module in the allow-list still correspond to a REAL ROUTE?
 *
 * moduleUsageMath.test.ts already pins moduleFromPath() hard — deep paths, query
 * strings, segment-vs-prefix, casing, junk. But every one of those assertions is
 * SELF-REFERENTIAL: it checks `moduleFromPath('/' + m) === m` for m in MODULES,
 * which is true by construction and stays true no matter what the app's routes
 * are actually called.
 *
 * So the one failure that matters most is exactly the one that suite cannot see.
 * Rename src/app/(dashboard)/asm to /area-sales and:
 *
 *   · MODULES still contains "asm",
 *   · moduleFromPath("/asm") still returns "asm",
 *   · every existing test still passes,
 *   · and /operations/usage reports ASM as "no data" forever while its traffic
 *     piles up silently in 'other'.
 *
 * That is a reporting bug with no error, no log line and no failing test — the
 * worst shape a bug can have on a page whose entire job is to be believed. This
 * suite is the tripwire: it reaches out of the module and checks the allow-list
 * against the filesystem, so a route rename breaks the build instead of quietly
 * corrupting a metric.
 *
 * DELIBERATELY ONE-DIRECTIONAL. It asserts every MODULES entry has a route, and
 * NOT that every route is in MODULES — most of the dashboard (/leads, /admin,
 * /operations itself) is untracked on purpose, so the reverse check would fail
 * on day one and would have to be suppressed with an ignore-list that nobody
 * would maintain.
 */

const DASHBOARD_DIR = fileURLToPath(
  new URL("../../../app/(dashboard)", import.meta.url),
);

describe("MODULES allow-list vs the real dashboard routes", () => {
  it("finds the dashboard route group (guards the path this suite depends on)", () => {
    // Without this, moving the route group would turn every assertion below into
    // a false PASS-by-absence rather than the failure it should be.
    expect(existsSync(DASHBOARD_DIR)).toBe(true);
  });

  it("has a real route directory for every module in the allow-list", () => {
    const dirs = new Set(
      readdirSync(DASHBOARD_DIR).filter((name) =>
        statSync(`${DASHBOARD_DIR}/${name}`).isDirectory(),
      ),
    );

    // Asserted as a whole set rather than in a loop: a rename usually moves one
    // module, and seeing "missing: [asm]" beside the full list is a far more
    // useful failure than the first expect() blowing up with a bare `false`.
    const missing = MODULES.filter((m) => !dirs.has(m));
    expect(missing).toEqual([]);
  });

  it("serves a page at each module's bare route, not just a directory", () => {
    // A directory holding only _components or a layout.tsx is not somewhere a
    // person can navigate, so it could never produce a heartbeat.
    const withoutPage = MODULES.filter(
      (m) => !existsSync(`${DASHBOARD_DIR}/${m}/page.tsx`),
    );
    expect(withoutPage).toEqual([]);
  });

  it("resolves each module's real route back to that module", () => {
    // Ties the two halves together: the directory exists AND the resolver maps
    // its URL to the label stored in module_usage_daily.
    for (const m of MODULES) {
      expect(moduleFromPath(`/${m}`)).toBe(m);
    }
  });
});
