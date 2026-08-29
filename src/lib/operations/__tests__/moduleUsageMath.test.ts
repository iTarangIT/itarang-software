import { describe, expect, it } from "vitest";

import {
  MODULE_LABELS,
  moduleLabel,
  rollUpModuleDetail,
  rollUpModuleUsers,
  rollUpModules,
  type ModuleDayRaw,
  type ModuleUsageRaw,
  type ModuleUserRaw,
} from "../moduleUsageMath";
import {
  MODULES,
  MODULE_OTHER,
  moduleFromPath,
  normaliseModule,
} from "@/lib/usage/constants";

/**
 * E-215's pure half. The privacy properties live in SQL and in the write path,
 * so what is testable here is the reporting contract — and the two things worth
 * pinning hardest are that an UNUSED module still renders (the question the
 * feature exists to answer) and that moduleFromPath never leaks a path.
 */

const raw = (
  module: string,
  role_bucket: string,
  pings: number,
  sessions: number,
): ModuleUsageRaw => ({ module, role_bucket, pings, sessions });

describe("moduleFromPath", () => {
  it("reduces a deep path with a query string to the bare module label", () => {
    // The whole privacy argument for per-module tracking is that this returns
    // four letters and not the URL it was given.
    expect(moduleFromPath("/nbfc/applications/PL-2291/documents?tab=kyc")).toBe(
      "nbfc",
    );
  });

  it("maps every module in the allow-list to itself", () => {
    for (const m of MODULES) {
      expect(moduleFromPath(`/${m}`)).toBe(m);
      expect(moduleFromPath(`/${m}/`)).toBe(m);
      expect(moduleFromPath(`/${m}/deep/path`)).toBe(m);
    }
  });

  it("matches on the whole first segment, not a prefix", () => {
    // A startsWith() implementation would fold this into "sales-head" and the
    // numbers would be silently wrong forever.
    expect(moduleFromPath("/sales-headcount/report")).toBe(MODULE_OTHER);
    expect(moduleFromPath("/nbfcx")).toBe(MODULE_OTHER);
    expect(moduleFromPath("/asm-archive")).toBe(MODULE_OTHER);
  });

  it("does not track the console itself, the root, or unknown modules", () => {
    expect(moduleFromPath("/operations/usage")).toBe(MODULE_OTHER);
    expect(moduleFromPath("/")).toBe(MODULE_OTHER);
    expect(moduleFromPath("/leads")).toBe(MODULE_OTHER);
  });

  it("never throws on junk, because it runs inside the ping path", () => {
    // An exception here would kill the heartbeat timer for the tab's lifetime.
    expect(moduleFromPath("")).toBe(MODULE_OTHER);
    expect(moduleFromPath(null)).toBe(MODULE_OTHER);
    expect(moduleFromPath(undefined)).toBe(MODULE_OTHER);
    expect(moduleFromPath("no-leading-slash")).toBe(MODULE_OTHER);
    expect(moduleFromPath("////")).toBe(MODULE_OTHER);
    expect(moduleFromPath("?only=query")).toBe(MODULE_OTHER);
  });

  it("is case-insensitive on the segment", () => {
    expect(moduleFromPath("/NBFC/x")).toBe("nbfc");
    expect(moduleFromPath("/Dealer-Portal")).toBe("dealer-portal");
  });
});

describe("normaliseModule", () => {
  it("accepts every allow-listed label", () => {
    for (const m of MODULES) expect(normaliseModule(m)).toBe(m);
  });

  it("rejects anything not on the list, however plausible", () => {
    // This is the guard between an untrusted browser string and a column with
    // no CHECK constraint.
    expect(normaliseModule("leads")).toBe(MODULE_OTHER);
    expect(normaliseModule("operations")).toBe(MODULE_OTHER);
    expect(normaliseModule("nbfc; DROP TABLE users")).toBe(MODULE_OTHER);
    expect(normaliseModule("x".repeat(500))).toBe(MODULE_OTHER);
  });

  it("does NOT accept a path — a path arriving here is a bug", () => {
    // Falling back to moduleFromPath() would quietly support callers that
    // skipped it, which is how a path column gets re-invented by accident.
    expect(normaliseModule("/nbfc/applications/PL-2291")).toBe(MODULE_OTHER);
    expect(normaliseModule("/nbfc")).toBe(MODULE_OTHER);
  });

  it("tolerates casing and surrounding whitespace", () => {
    expect(normaliseModule("  NBFC  ")).toBe("nbfc");
    expect(normaliseModule("Sales-Head")).toBe("sales-head");
  });

  it("coerces every non-string to 'other' without throwing", () => {
    for (const junk of [null, undefined, 42, {}, [], true, Symbol("x")]) {
      expect(normaliseModule(junk)).toBe(MODULE_OTHER);
    }
  });
});

describe("rollUpModules", () => {
  it("emits a row for every allow-listed module even with no data at all", () => {
    // THE point of the table: "nobody has opened /asm all month" is only
    // visible if an absent module still renders.
    const rows = rollUpModules([]);
    expect(rows).toHaveLength(MODULES.length);
    expect(rows.map((r) => r.module).sort()).toEqual([...MODULES].sort());
    expect(rows.every((r) => r.never_seen)).toBe(true);
    expect(rows.every((r) => r.pings === 0 && r.sessions === 0)).toBe(true);
  });

  it("distinguishes never_seen from a genuine zero", () => {
    const rows = rollUpModules([raw("asm", "internal", 0, 0)]);
    const asm = rows.find((r) => r.module === "asm")!;
    const ceo = rows.find((r) => r.module === "ceo")!;
    expect(asm.never_seen).toBe(false); // a row exists, it just reads zero
    expect(ceo.never_seen).toBe(true); // no row at all
  });

  it("sums the two role buckets and keeps them separately", () => {
    const rows = rollUpModules([
      raw("dealer-portal", "internal", 10, 2),
      raw("dealer-portal", "external", 40, 9),
    ]);
    const dp = rows.find((r) => r.module === "dealer-portal")!;
    expect(dp.pings).toBe(50);
    expect(dp.sessions).toBe(11);
    expect(dp.internal_sessions).toBe(2);
    expect(dp.external_sessions).toBe(9);
  });

  it("treats an unrecognised bucket as internal rather than dropping it", () => {
    // Losing the row entirely would understate usage; the totals must still add
    // up even if a future bucket name arrives before this code knows it.
    const rows = rollUpModules([raw("ceo", "something-new", 4, 1)]);
    const ceo = rows.find((r) => r.module === "ceo")!;
    expect(ceo.sessions).toBe(1);
    expect(ceo.internal_sessions).toBe(1);
    expect(ceo.external_sessions).toBe(0);
  });

  it("converts pings to minutes at the heartbeat interval", () => {
    // 12 pings x 300s = 3600s = 60 minutes.
    const rows = rollUpModules([raw("nbfc", "internal", 12, 3)], 300);
    expect(rows.find((r) => r.module === "nbfc")!.minutes).toBe(60);
  });

  it("honours a non-default heartbeat interval", () => {
    const rows = rollUpModules([raw("nbfc", "internal", 12, 3)], 600);
    expect(rows.find((r) => r.module === "nbfc")!.minutes).toBe(120);
  });

  it("computes share against the window total and sums to 1", () => {
    const rows = rollUpModules([
      raw("nbfc", "internal", 75, 5),
      raw("asm", "internal", 25, 2),
    ]);
    expect(rows.find((r) => r.module === "nbfc")!.share).toBeCloseTo(0.75);
    expect(rows.find((r) => r.module === "asm")!.share).toBeCloseTo(0.25);
    const total = rows.reduce((s, r) => s + r.share, 0);
    expect(total).toBeCloseTo(1);
  });

  it("returns share 0 rather than NaN when nothing was recorded", () => {
    // The normal state before USAGE_HEARTBEAT is switched on. NaN would render
    // as "—" in every row and read like an outage.
    for (const r of rollUpModules([])) {
      expect(r.share).toBe(0);
      expect(Number.isNaN(r.share)).toBe(false);
    }
  });

  it("includes 'other' only when it actually appears", () => {
    expect(rollUpModules([]).some((r) => r.module === MODULE_OTHER)).toBe(false);

    const withOther = rollUpModules([raw(MODULE_OTHER, "internal", 9, 3)]);
    const other = withOther.find((r) => r.module === MODULE_OTHER);
    expect(other).toBeDefined();
    expect(other!.pings).toBe(9);
  });

  it("sorts busiest first, breaking ties in allow-list order", () => {
    const rows = rollUpModules([
      raw("asm", "internal", 5, 1),
      raw("nbfc", "internal", 90, 9),
      raw("ceo", "internal", 5, 1),
    ]);
    expect(rows[0]!.module).toBe("nbfc");
    // asm and ceo both have 5 pings; MODULES order puts ceo before asm, and the
    // sort is stable, so an all-zero or tied table renders predictably.
    const tied = rows.filter((r) => r.pings === 5).map((r) => r.module);
    expect(tied).toEqual(["ceo", "asm"]);
  });

  it("survives non-finite counts without poisoning the totals", () => {
    // One bad row must not turn every figure on the page into NaN.
    const rows = rollUpModules([
      raw("nbfc", "internal", Number.NaN, Number.POSITIVE_INFINITY),
      raw("asm", "internal", 10, 2),
    ]);
    expect(rows.find((r) => r.module === "nbfc")!.pings).toBe(0);
    expect(rows.find((r) => r.module === "nbfc")!.sessions).toBe(0);
    expect(rows.find((r) => r.module === "asm")!.share).toBeCloseTo(1);
  });
});

describe("labels", () => {
  it("names every allow-listed module plus 'other'", () => {
    for (const m of [...MODULES, MODULE_OTHER]) {
      expect(MODULE_LABELS[m]).toBeTruthy();
    }
  });

  it("falls back to the raw value for an unknown module", () => {
    // A label map miss must not render "undefined" in the table.
    expect(moduleLabel("brand-new-module")).toBe("brand-new-module");
  });
});

describe("rollUpModuleDetail", () => {
  const day = (
    day: string,
    role_bucket: string,
    pings: number,
    sessions: number,
  ): ModuleDayRaw => ({ day, role_bucket, pings, sessions });

  it("merges both buckets of one day into a single row", () => {
    const d = rollUpModuleDetail("dealer-portal", [
      day("2026-08-17", "internal", 3, 1),
      day("2026-08-17", "external", 5, 2),
    ]);

    expect(d.days).toHaveLength(1);
    expect(d.days[0]!.pings).toBe(8);
    expect(d.days[0]!.sessions).toBe(3);
    expect(d.days[0]!.internal_sessions).toBe(1);
    expect(d.days[0]!.external_sessions).toBe(2);
  });

  it("returns days oldest-first regardless of input order", () => {
    // The chart draws a left-to-right time axis; unsorted input would render
    // the month backwards without any error to notice.
    const d = rollUpModuleDetail("asm", [
      day("2026-08-17", "internal", 1, 1),
      day("2026-08-11", "internal", 1, 1),
      day("2026-08-14", "internal", 1, 1),
    ]);
    expect(d.days.map((p) => p.day)).toEqual([
      "2026-08-11",
      "2026-08-14",
      "2026-08-17",
    ]);
    expect(d.first_day).toBe("2026-08-11");
    expect(d.last_day).toBe("2026-08-17");
  });

  it("leaves gaps unfilled — this is a table of days that had activity", () => {
    // Deliberately unlike fillLoginDays(): inventing 27 empty rows would bury
    // the three days that carried anything.
    const d = rollUpModuleDetail("ceo", [
      day("2026-08-11", "internal", 2, 1),
      day("2026-08-17", "internal", 2, 1),
    ]);
    expect(d.days).toHaveLength(2);
  });

  it("sums the per-day minutes to the header figure", () => {
    // Deriving each row from its own pings and the header from the total keeps
    // the column adding up instead of drifting by a rounding step per row.
    const d = rollUpModuleDetail("nbfc", [
      day("2026-08-16", "internal", 3, 1),
      day("2026-08-17", "internal", 4, 1),
    ]);
    expect(d.minutes).toBe(35);
    expect(d.days.reduce((t, p) => t + p.minutes, 0)).toBe(35);
  });

  it("reports an unused module as empty rather than throwing", () => {
    const d = rollUpModuleDetail("sales-head", []);
    expect(d.empty).toBe(true);
    expect(d.days).toEqual([]);
    expect(d.sessions).toBe(0);
    expect(d.minutes).toBe(0);
    expect(d.first_day).toBeNull();
    expect(d.last_day).toBeNull();
    expect(d.label).toBe("Sales Head");
  });

  it("survives a non-finite counter without poisoning every total", () => {
    // One bad row must not turn the whole card into "—", which reads as an
    // outage rather than as a single corrupt value.
    const d = rollUpModuleDetail("asm", [
      day("2026-08-17", "internal", Number.NaN, 1),
      day("2026-08-17", "internal", 4, Number.POSITIVE_INFINITY),
    ]);
    expect(Number.isFinite(d.pings)).toBe(true);
    expect(Number.isFinite(d.minutes)).toBe(true);
    expect(d.pings).toBe(4);
    expect(d.sessions).toBe(1);
  });

  it("carries the module through even when it is not on the allow-list", () => {
    // 'other' is drillable, and a module retired from MODULES still has rows.
    expect(rollUpModuleDetail(MODULE_OTHER, []).module).toBe(MODULE_OTHER);
    expect(rollUpModuleDetail(MODULE_OTHER, []).label).toBe("Other / untracked");
  });
});

describe("rollUpModuleUsers", () => {
  const user = (
    over: Partial<ModuleUserRaw> & { user_id: string },
  ): ModuleUserRaw => ({
    name: "Someone",
    role_at_ping: "sales_head",
    role_bucket: "internal",
    pings: 1,
    sessions: 1,
    last_day: "2026-08-17",
    days_active: 1,
    ...over,
  });

  it("names nobody when E-216 has recorded nobody", () => {
    // THE property that matters most: an empty result must stay empty. Inferring
    // a person from a session is what module_visit_keys would do, and it was
    // wrong for every row tested on live data.
    expect(rollUpModuleUsers([])).toEqual([]);
  });

  it("orders by usage, breaking ties by name for a stable table", () => {
    const rows = rollUpModuleUsers([
      user({ user_id: "a", name: "Zoe", pings: 2 }),
      user({ user_id: "b", name: "Anirudh", pings: 9 }),
      user({ user_id: "c", name: "Nidhi", pings: 2 }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Anirudh", "Nidhi", "Zoe"]);
  });

  it("converts pings to minutes at the heartbeat rate", () => {
    const [row] = rollUpModuleUsers([user({ user_id: "a", pings: 7 })]);
    expect(row!.minutes).toBe(35);
  });

  it("keeps external accounts external", () => {
    // Dealers and NBFC partners must never be re-labelled internal by a read
    // path — the bucket was decided at ping time and is stored, not re-derived.
    const [row] = rollUpModuleUsers([
      user({ user_id: "d", role_at_ping: "dealer", role_bucket: "external" }),
    ]);
    expect(row!.bucket).toBe("external");
    expect(row!.role).toBe("dealer");
  });

  it("treats any unrecognised bucket as internal rather than dropping the row", () => {
    const [row] = rollUpModuleUsers([
      user({ user_id: "x", role_bucket: "" }),
    ]);
    expect(row!.bucket).toBe("internal");
  });

  it("renders a missing name or role as 'unknown', never blank", () => {
    // An auth user with no `users` row is real (one exists in the live data).
    // A nameless row the reader cannot act on is worse than an explicit unknown.
    const [row] = rollUpModuleUsers([
      user({ user_id: "n", name: "  ", role_at_ping: null }),
    ]);
    expect(row!.name).toBe("unknown");
    expect(row!.role).toBe("unknown");
  });

  it("survives non-finite counters without poisoning the row", () => {
    const [row] = rollUpModuleUsers([
      user({ user_id: "a", pings: Number.NaN, sessions: Number.NaN }),
    ]);
    expect(row!.pings).toBe(0);
    expect(row!.sessions).toBe(0);
    expect(Number.isFinite(row!.minutes)).toBe(true);
  });
});
