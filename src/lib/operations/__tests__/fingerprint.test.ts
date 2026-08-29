import { describe, expect, it } from "vitest";

import {
  fingerprint,
  normaliseLevel,
  normaliseMessage,
} from "../fingerprint";

/**
 * Fingerprinting decides what "the same error" means, so a change here
 * re-buckets the whole /operations/logs top-errors table. These tests pin the
 * two failure modes that matter:
 *
 *   · under-grouping — one bug in a loop renders as thousands of distinct rows,
 *     which is the wall of text the explorer exists to prevent;
 *   · over-grouping — genuinely different errors collapse into one, and the
 *     second one is invisible.
 */

const groups = (a: string, b: string) =>
  fingerprint("web", "error", a) === fingerprint("web", "error", b);

describe("normaliseMessage", () => {
  it("strips the volatile parts that differ between occurrences", () => {
    expect(
      normaliseMessage("2026-08-04T10:05:01 failed for 41ab3c2d-1111-4222-8333-444455556666"),
    ).toBe("<ts> failed for <uuid>");
  });

  it("collapses repeated whitespace and lowercases", () => {
    expect(normaliseMessage("ERROR   Something   Broke")).toBe("error something broke");
  });
});

describe("fingerprint groups the same error together", () => {
  it.each([
    [
      "different uuids",
      "user 41ab3c2d-1111-4222-8333-444455556666 not found",
      "user 92cd7e8f-9999-4888-8777-666655554444 not found",
    ],
    // Regression: `\b\d+\b` never matched a number followed by a unit, because
    // "3" and "m" in "1423ms" are both word characters and there is no boundary
    // between them. Every timing line stayed ungrouped.
    ["numbers carrying a unit", "request took 1423ms", "request took 91ms"],
    ["ip addresses and ports", "ECONNREFUSED 10.0.0.5:5432", "ECONNREFUSED 172.16.9.31:5432"],
    [
      "timestamps and source positions",
      "2026-08-04T10:05:01 ERROR at route.ts:88:12",
      "2026-08-04T11:44:59 ERROR at route.ts:91:4",
    ],
    ["hex ids", "deploy sha a1b2c3d4e5f6 failed", "deploy sha 998877665544 failed"],
  ])("%s", (_label, a, b) => {
    expect(groups(a, b)).toBe(true);
  });
});

describe("fingerprint keeps genuinely different errors apart", () => {
  it.each([
    ["unrelated messages", "user not found", "payment declined"],
    [
      "same target, different failure",
      "connect ECONNREFUSED 10.0.0.5:5432",
      "connect ETIMEDOUT 10.0.0.5:5432",
    ],
    // The leading \b in the number rule is what protects these: there is no
    // word boundary before the digits in "utf8" or "ipv4", so they survive
    // normalisation intact.
    ["digits inside an identifier", "invalid utf8 sequence", "invalid utf16 sequence"],
    ["protocol versions", "ipv4 bind failed", "ipv6 bind failed"],
  ])("%s", (_label, a, b) => {
    expect(groups(a, b)).toBe(false);
  });

  it("partitions by service and by level", () => {
    const message = "database is unavailable";
    expect(fingerprint("web", "error", message)).not.toBe(
      fingerprint("nginx", "error", message),
    );
    expect(fingerprint("web", "error", message)).not.toBe(
      fingerprint("web", "warn", message),
    );
  });
});

it("is exactly as wide as ops_log_events.fingerprint", () => {
  // varchar(64), and sha256 hex is 64 — no truncation anywhere in the path.
  expect(fingerprint("web", "error", "anything")).toHaveLength(64);
});

describe("normaliseLevel", () => {
  it.each([
    ["error", "error"],
    ["ERROR", "error"],
    ["fatal", "error"],
    ["crit", "error"],
    ["Warning", "warn"],
    ["notice", "warn"],
    ["debug", "info"],
    ["banana", "info"],
  ])("maps %s to %s", (input, expected) => {
    expect(normaliseLevel(input)).toBe(expected);
  });
});
