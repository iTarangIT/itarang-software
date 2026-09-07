import { describe, expect, it } from "vitest";

import {
  daysElapsed,
  deriveFileStage,
  formatDuration,
  waitingOnForDocStatus,
  type FileStageInput,
} from "@/lib/nbfc/file-tracker";

const T = (iso: string) => new Date(iso);

const ASSIGNED = T("2026-08-01T10:00:00Z");

function input(over: Partial<FileStageInput> = {}): FileStageInput {
  return {
    assignmentStatus: "pending",
    assignedAt: ASSIGNED,
    decidedAt: null,
    rejectionForwardedAt: null,
    rejectionAdminDueAt: null,
    openRequest: null,
    pendingVerdict: null,
    offerSubmittedAt: null,
    sanctionedAt: null,
    disbursedAt: null,
    ...over,
  };
}

describe("deriveFileStage", () => {
  it("reports a fresh assignment as sitting with the lender", () => {
    const s = deriveFileStage(input());
    expect(s.key).toBe("with_nbfc");
    expect(s.waitingOn).toBe("nbfc");
    expect(s.since).toEqual(ASSIGNED);
  });

  it("distinguishes in_progress from pending, still on the lender", () => {
    const s = deriveFileStage(input({ assignmentStatus: "in_progress" }));
    expect(s.key).toBe("with_nbfc");
    expect(s.label).toBe("Under lender review");
    expect(s.waitingOn).toBe("nbfc");
  });

  it("puts a rejection on the admin until it is forwarded", () => {
    const decided = T("2026-08-05T09:00:00Z");
    const due = T("2026-08-06T09:00:00Z");
    const s = deriveFileStage(
      input({
        assignmentStatus: "declined",
        decidedAt: decided,
        rejectionAdminDueAt: due,
      }),
    );
    expect(s.key).toBe("rejected");
    expect(s.waitingOn).toBe("admin");
    expect(s.since).toEqual(decided);
    expect(s.slaDueAt).toEqual(due);
  });

  it("moves a forwarded rejection to the dealer and drops the SLA clock", () => {
    const s = deriveFileStage(
      input({
        assignmentStatus: "declined",
        decidedAt: T("2026-08-05T09:00:00Z"),
        rejectionAdminDueAt: T("2026-08-06T09:00:00Z"),
        rejectionForwardedAt: T("2026-08-05T18:00:00Z"),
      }),
    );
    expect(s.waitingOn).toBe("dealer");
    expect(s.slaDueAt).toBeNull();
  });

  it("a rejection outranks an open document request", () => {
    const s = deriveFileStage(
      input({
        assignmentStatus: "declined",
        decidedAt: T("2026-08-05T09:00:00Z"),
        openRequest: {
          status: "nbfc_raised",
          updatedAt: T("2026-08-04T09:00:00Z"),
          slaDueAt: null,
        },
      }),
    );
    expect(s.key).toBe("rejected");
  });

  it("surfaces an open document request and who holds it", () => {
    const updated = T("2026-08-03T12:00:00Z");
    const s = deriveFileStage(
      input({
        openRequest: {
          status: "forwarded_to_dealer",
          updatedAt: updated,
          slaDueAt: null,
        },
      }),
    );
    expect(s.key).toBe("docs");
    expect(s.waitingOn).toBe("dealer");
    expect(s.since).toEqual(updated);
  });

  it("an open request outranks an unforwarded verdict", () => {
    const s = deriveFileStage(
      input({
        openRequest: {
          status: "admin_review",
          updatedAt: T("2026-08-03T12:00:00Z"),
          slaDueAt: null,
        },
        pendingVerdict: {
          verdict: "queried",
          verifiedAt: T("2026-08-02T12:00:00Z"),
          slaDueAt: null,
        },
      }),
    );
    expect(s.key).toBe("docs");
  });

  it("flags an unforwarded verdict as the admin's move", () => {
    const verified = T("2026-08-02T12:00:00Z");
    const s = deriveFileStage(
      input({
        pendingVerdict: {
          verdict: "rejected",
          verifiedAt: verified,
          slaDueAt: T("2026-08-03T12:00:00Z"),
        },
      }),
    );
    expect(s.key).toBe("verdict");
    expect(s.waitingOn).toBe("admin");
    expect(s.since).toEqual(verified);
  });

  it("reports a sanctioned file as blocking nobody", () => {
    const sanctioned = T("2026-08-10T08:00:00Z");
    const s = deriveFileStage(
      input({ assignmentStatus: "selected", sanctionedAt: sanctioned }),
    );
    expect(s.key).toBe("sanctioned");
    expect(s.waitingOn).toBe("none");
    expect(s.since).toEqual(sanctioned);
  });

  it("prefers disbursed over sanctioned", () => {
    const s = deriveFileStage(
      input({
        assignmentStatus: "selected",
        sanctionedAt: T("2026-08-10T08:00:00Z"),
        disbursedAt: T("2026-08-11T08:00:00Z"),
      }),
    );
    expect(s.key).toBe("disbursed");
  });

  it("waits on the dealer once an offer is in", () => {
    const submitted = T("2026-08-06T08:00:00Z");
    const s = deriveFileStage(
      input({ assignmentStatus: "offer_submitted", offerSubmittedAt: submitted }),
    );
    expect(s.key).toBe("offer");
    expect(s.waitingOn).toBe("dealer");
    expect(s.since).toEqual(submitted);
  });

  it("treats a resolved assignment as blocking nobody", () => {
    const s = deriveFileStage(
      input({ assignmentStatus: "withdrawn", decidedAt: T("2026-08-07T08:00:00Z") }),
    );
    expect(s.key).toBe("unknown");
    expect(s.waitingOn).toBe("none");
    expect(s.label).toBe("Withdrawn");
  });
});

describe("waitingOnForDocStatus", () => {
  it("maps the iTarang-held legs to admin", () => {
    expect(waitingOnForDocStatus("nbfc_raised")).toBe("admin");
    expect(waitingOnForDocStatus("admin_review")).toBe("admin");
    expect(waitingOnForDocStatus("admin_review_upload")).toBe("admin");
  });

  it("maps the dealer- and customer-held legs", () => {
    expect(waitingOnForDocStatus("forwarded_to_dealer")).toBe("dealer");
    expect(waitingOnForDocStatus("dealer_review")).toBe("dealer");
    expect(waitingOnForDocStatus("with_customer")).toBe("customer");
  });
});

describe("formatDuration", () => {
  it("renders the coarse buckets", () => {
    expect(formatDuration(30_000)).toBe("just now");
    expect(formatDuration(5 * 60_000)).toBe("5m");
    expect(formatDuration(90 * 60_000)).toBe("1h 30m");
    expect(formatDuration(26 * 3_600_000)).toBe("1d 2h");
  });

  it("returns an em dash for missing or nonsensical input", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});

describe("daysElapsed", () => {
  it("floors to whole days and never goes negative", () => {
    expect(daysElapsed(0)).toBe(0);
    expect(daysElapsed(47 * 3_600_000)).toBe(1);
    expect(daysElapsed(null)).toBe(0);
    expect(daysElapsed(-5)).toBe(0);
  });
});
