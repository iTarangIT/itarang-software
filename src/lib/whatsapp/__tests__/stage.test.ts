import { describe, expect, it } from "vitest";

import { activityOf, stageOf, STAGE_LABEL } from "../stage";
import { prospectDisplayName, PLACEHOLDER_COMPANY } from "../labels";

describe("stageOf", () => {
  it("labels a bare greeting as a new enquiry", () => {
    expect(stageOf({ currentState: "GREETING", onboardingStatus: "draft" })).toBe(
      "new_enquiry",
    );
  });

  it("tracks document collection", () => {
    expect(
      stageOf({ currentState: "COLLECTING_DOC", onboardingStatus: "draft" }),
    ).toBe("collecting_docs");
  });

  // The admin's decision lives on the application; the session keeps whatever
  // state it was parked in, so application status has to win.
  it("prefers application status over a stale conversation state", () => {
    expect(
      stageOf({ currentState: "COLLECTING_DOC", onboardingStatus: "rejected" }),
    ).toBe("rejected");
    expect(
      stageOf({ currentState: "COLLECTING_DOC", onboardingStatus: "approved" }),
    ).toBe("approved");
    expect(
      stageOf({
        currentState: "AWAIT_CONFIRM",
        onboardingStatus: "correction_requested",
      }),
    ).toBe("correction");
  });

  it("recognises the post-approval console and operator menu prefixes", () => {
    expect(stageOf({ currentState: "DC_LEAD_DOCS" })).toBe("customer_lead");
    expect(stageOf({ currentState: "OP_PICK_DEALER" })).toBe("operator_menu");
  });

  it("degrades gracefully for an unmapped state", () => {
    expect(stageOf({ currentState: "SOME_FUTURE_STATE" })).toBe("unknown");
    expect(stageOf({ currentState: null })).toBe("unknown");
    expect(STAGE_LABEL.unknown).toBeTruthy();
  });
});

describe("activityOf", () => {
  const now = new Date("2026-07-27T12:00:00Z");

  it("treats a never-replied contact as stalled rather than hiding it", () => {
    expect(activityOf(null, now)).toBe("stale");
  });

  it("buckets by age", () => {
    expect(activityOf("2026-07-27T11:40:00Z", now)).toBe("live");
    expect(activityOf("2026-07-26T12:00:00Z", now)).toBe("recent");
    expect(activityOf("2026-07-20T12:00:00Z", now)).toBe("stale");
  });
});

describe("prospectDisplayName", () => {
  it("never renders the placeholder company", () => {
    expect(
      prospectDisplayName({
        companyName: PLACEHOLDER_COMPANY,
        contactName: "Rahul",
        waPhone: "919876543210",
      }),
    ).toBe("Rahul");
  });

  it("falls back to the phone number for a bare hi", () => {
    expect(
      prospectDisplayName({
        companyName: PLACEHOLDER_COMPANY,
        waPhone: "919876543210",
      }),
    ).toBe("+919876543210");
  });

  it("prefers a real company name", () => {
    expect(
      prospectDisplayName({
        companyName: "Sharma Motors",
        ownerName: "Rahul Sharma",
      }),
    ).toBe("Sharma Motors");
  });
});
