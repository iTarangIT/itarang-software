/**
 * RELEASE-BLOCKING.
 *
 * The E-231 notification gate is enforced at every place that writes a row into
 * `notifications`. There are exactly three such places, and the design's
 * correctness is entirely contingent on that number not growing quietly:
 *
 *   src/lib/notifications/emit.ts        — the hub. Splits bell from email.
 *   src/lib/notifications/notify.ts      — notifyRoles / notifyUser / notifyNbfcTenant.
 *   src/lib/buyback/dispatch.ts          — writeBell.
 *
 * A fourth writer added without a gate would be invisible: notifications would
 * simply keep arriving in a dashboard the admin had muted, with no error and
 * nothing in the logs. This test is the thing that notices.
 *
 * If you are here because this test failed, you have two honest options:
 *   1. Route the new write through emit(), which is gated already; or
 *   2. Call blockedDashboardsFor(type) from src/lib/notifications/access.ts and
 *      filter before inserting — then add the file to ALLOWED below.
 * Adding the file to ALLOWED without doing (2) defeats the entire feature.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

const ALLOWED = [
  "lib/notifications/emit.ts",
  "lib/notifications/notify.ts",
  "lib/buyback/dispatch.ts",
].sort();

/** `INSERT INTO notifications` in raw SQL, or drizzle's typed insert. */
const WRITES = /insert\s+into\s+notifications\b|\.insert\(\s*notifications\s*\)/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walk(full, out);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("notification write paths", () => {
  it("are exactly the three files the E-231 gate covers", () => {
    const writers = walk(SRC)
      .filter((f) => WRITES.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f).split(sep).join("/"))
      .sort();

    expect(
      writers,
      "a file writes to `notifications` without going through the E-231 gate — " +
        "read the header of this test before changing ALLOWED",
    ).toEqual(ALLOWED);
  });

  it("each consults the access gate", () => {
    for (const rel of ALLOWED) {
      const source = readFileSync(join(SRC, rel), "utf8");
      expect(
        /notifications\/access|blockedDashboardsFor|filterAllowedRoles/.test(source),
        `${rel} writes notifications but never consults src/lib/notifications/access.ts`,
      ).toBe(true);
    }
  });
});
