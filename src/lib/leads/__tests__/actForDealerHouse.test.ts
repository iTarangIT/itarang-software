// ID 183 (21 Oct): the house login works pushed files in the dealer portal —
// its steps are recorded "Done by" (drafts coalesced), the dealer sees "being
// worked by" on his own screens, the house login's saves carry the dealer-wins
// header, and the "Done by" lines merge into the file's general history.
import { describe, expect, it } from "vitest";

import {
  carriesSeenHeader,
  doneByHistoryText,
  mergeTimeline,
  recordPlan,
  workNoteText,
} from "../actForDealer";

const ist = (s: string) => new Date(`${s}+05:30`);
const NOW = ist("2026-10-21T11:00:00");
const LIVE = { holderUserId: "u-admin", holderName: "Ravi", expiresAt: ist("2026-10-21T11:20:00") };

describe("recordPlan (Done by line + dealer notice)", () => {
  it("an ordinary step is always recorded; the dealer is told once per person per 30 minutes", () => {
    expect(recordPlan({ coalesce: false, sameStepRecent: false, anyRecent: false })).toEqual({ write: true, notify: true });
    expect(recordPlan({ coalesce: false, sameStepRecent: true, anyRecent: true })).toEqual({ write: true, notify: false });
  });
  it("a draft autosave writes one line per hold, then nothing until the hold runs out", () => {
    expect(recordPlan({ coalesce: true, sameStepRecent: false, anyRecent: false })).toEqual({ write: true, notify: true });
    expect(recordPlan({ coalesce: true, sameStepRecent: true, anyRecent: true })).toEqual({ write: false, notify: false });
  });
  it("a first draft save after another step this hold is recorded without a second notice", () => {
    expect(recordPlan({ coalesce: true, sameStepRecent: false, anyRecent: true })).toEqual({ write: true, notify: false });
  });
});

describe("workNoteText (being worked by, on the dealer's own screens)", () => {
  it("nothing when nobody holds the file or the note ran out", () => {
    expect(workNoteText(null, { userId: "d1", kind: "dealer" }, NOW)).toBeNull();
    expect(workNoteText({ ...LIVE, expiresAt: ist("2026-10-21T10:59:00") }, { userId: "d1", kind: "dealer" }, NOW)).toBeNull();
  });
  it("the dealer sees who and until when, and that he still wins", () => {
    const t = workNoteText(LIVE, { userId: "d1", kind: "dealer" }, NOW)!;
    expect(t).toMatch(/^Being worked by Ravi \(iTarang\) until /);
    expect(t).toMatch(/still yours/);
  });
  it("the holder sees their own note; another iTarang person is told they are blocked", () => {
    expect(workNoteText(LIVE, { userId: "u-admin", kind: "itarang" }, NOW)).toMatch(/^You are working this file until /);
    expect(workNoteText(LIVE, { userId: "u-house", kind: "house" }, NOW)).toMatch(/^This file is being worked by Ravi until .*Try again after that/);
  });
});

describe("carriesSeenHeader (the house login's saves carry the dealer's last action)", () => {
  const L = "LEAD-1";
  it("non-GET calls to this file's step routes", () => {
    for (const u of [
      "/api/kyc/LEAD-1/save-draft",
      "/api/lead/LEAD-1/step-5/confirm-dispatch",
      "/api/coborrower/LEAD-1",
      "/api/dealer/leads/LEAD-1",
      "http://localhost:3000/api/lead/LEAD-1/product-photo?x=1",
    ]) {
      expect(carriesSeenHeader(u, "POST", L), u).toBe(true);
    }
    expect(carriesSeenHeader("/api/dealer/leads/LEAD-1", "patch", L)).toBe(true);
  });
  it("not reads, not other files, not other routes", () => {
    expect(carriesSeenHeader("/api/kyc/LEAD-1/save-draft", "GET", L)).toBe(false);
    expect(carriesSeenHeader("/api/kyc/LEAD-1/save-draft", undefined, L)).toBe(false);
    expect(carriesSeenHeader("/api/kyc/LEAD-12/save-draft", "POST", L)).toBe(false);
    expect(carriesSeenHeader("/api/leads/create", "POST", L)).toBe(false);
    expect(carriesSeenHeader("/api/notifications", "POST", L)).toBe(false);
    expect(carriesSeenHeader("/api/kyc/LEAD-1/x", "POST", "")).toBe(false);
  });
});

describe("Done by lines on the file's general history", () => {
  it("reads as the line plus the step", () => {
    expect(doneByHistoryText({ line: "Done by Ravi for ABC Motors", step: "confirmed dispatch (Step 5)" })).toBe(
      "Done by Ravi for ABC Motors: confirmed dispatch (Step 5)",
    );
    expect(doneByHistoryText({ line: "Done by Ravi for ABC Motors", step: null })).toBe("Done by Ravi for ABC Motors");
  });
  it("merges by time, oldest first, stable for ties and undated rows first", () => {
    const out = mergeTimeline([
      { at: ist("2026-10-21T10:00:00"), item: "flow-10:00" },
      { at: ist("2026-10-21T09:00:00"), item: "doneby-09:00" },
      { at: null, item: "undated" },
      { at: ist("2026-10-21T10:00:00"), item: "doneby-10:00" },
    ]);
    expect(out).toEqual(["undated", "doneby-09:00", "flow-10:00", "doneby-10:00"]);
  });
});
