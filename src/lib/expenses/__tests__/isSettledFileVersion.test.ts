import { describe, expect, it } from "vitest";

import { isSettledFileVersion } from "@/lib/expenses/retryPolicy";

/**
 * The rule that decides whether the Drive scanner re-reads a file it has
 * already recorded.
 *
 * Getting this wrong is expensive in both directions, which is why it is a pure
 * function with its own tests rather than a WHERE clause:
 *
 *  - Too settled, and a transient failure becomes permanent. That is the bug
 *    this replaces: `loadSeenVersions` matched on (file id, checksum) alone, a
 *    PDF's checksum never changes, and 33 purchase invoices that failed with
 *    "429 You have no credits remaining" were never read again. Every later
 *    scan reported "333 files, 0 new" and imported nothing.
 *  - Too eager, and a partially-imported costing sheet is rewritten to
 *    `duplicate`, losing the un-imported lines out of the attention queue; or
 *    the six-hourly ticker re-bills an unreadable file for ever.
 */
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-08T12:00:00Z");

const row = (over: Partial<Parameters<typeof isSettledFileVersion>[0]> = {}) => ({
  status: "failed",
  expenseIdCount: 0,
  lastAttemptedAt: new Date(NOW - 48 * HOUR),
  ...over,
});

describe("isSettledFileVersion", () => {
  it("settles a file that imported", () => {
    expect(isSettledFileVersion(row({ status: "imported", expenseIdCount: 1 }), { now: NOW })).toBe(
      true,
    );
  });

  it("settles a duplicate", () => {
    expect(isSettledFileVersion(row({ status: "duplicate" }), { now: NOW })).toBe(true);
  });

  it("settles an unsupported file — its mimetype and size cannot change without a new checksum", () => {
    expect(isSettledFileVersion(row({ status: "unsupported" }), { now: NOW })).toBe(true);
  });

  it("RETRIES a file that failed, once it is past the cooldown", () => {
    // The whole point. A 429/402/timeout belongs to the API, not to the file.
    expect(isSettledFileVersion(row({ status: "failed" }), { now: NOW })).toBe(false);
  });

  it("RETRIES a file the model could not read an amount from", () => {
    expect(
      isSettledFileVersion(row({ status: "needs_attention", expenseIdCount: 0 }), { now: NOW }),
    ).toBe(false);
  });

  it("does NOT retry a partially-imported costing sheet", () => {
    // importSheet returns needs_attention WITH expense ids when some rows
    // validated and others did not. Re-reading inserts nothing but would
    // overwrite the file row to 'duplicate' with an empty id array, dropping
    // the un-imported lines out of the needs-attention queue.
    expect(
      isSettledFileVersion(row({ status: "needs_attention", expenseIdCount: 7 }), { now: NOW }),
    ).toBe(true);
  });

  it("does not retry a failed file that already booked rows", () => {
    // A sheet that threw part-way leaves rows behind; expense_ids is the record.
    expect(
      isSettledFileVersion(row({ status: "failed", expenseIdCount: 3 }), { now: NOW }),
    ).toBe(true);
  });

  describe("cooldown", () => {
    it("rests a file attempted an hour ago", () => {
      expect(
        isSettledFileVersion(row({ lastAttemptedAt: new Date(NOW - HOUR) }), { now: NOW }),
      ).toBe(true);
    });

    it("releases it once the cooldown has passed", () => {
      expect(
        isSettledFileVersion(row({ lastAttemptedAt: new Date(NOW - 13 * HOUR) }), { now: NOW }),
      ).toBe(false);
    });

    it("is waived by ignoreCooldown, so the Retry button always retries", () => {
      expect(
        isSettledFileVersion(row({ lastAttemptedAt: new Date(NOW - HOUR) }), {
          now: NOW,
          ignoreCooldown: true,
        }),
      ).toBe(false);
    });

    it("never waives a status or a row count — Retry must not touch imported files", () => {
      expect(
        isSettledFileVersion(
          row({ status: "imported", lastAttemptedAt: new Date(NOW - HOUR) }),
          { now: NOW, ignoreCooldown: true },
        ),
      ).toBe(true);
      expect(
        isSettledFileVersion(
          row({ status: "needs_attention", expenseIdCount: 2 }),
          { now: NOW, ignoreCooldown: true },
        ),
      ).toBe(true);
    });

    it("retries a row with no timestamp rather than resting for ever", () => {
      expect(isSettledFileVersion(row({ lastAttemptedAt: null }), { now: NOW })).toBe(false);
    });
  });
});
