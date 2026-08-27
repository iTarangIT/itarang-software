import { describe, expect, it } from "vitest";

import { leadActionId, parseLeadAction } from "../leadActionButton";

describe("parseLeadAction", () => {
  it("reads a single-argument action", () => {
    expect(parseLeadAction("cb_start:LEAD-20260824-0042")).toEqual({
      action: "cb_start",
      leadId: "LEAD-20260824-0042",
    });
  });

  it("reads a two-argument action, splitting on the LAST colon", () => {
    // The lead id itself contains no colon today, but splitting on the first
    // one would make that an unstated constraint on lead-id format forever.
    expect(parseLeadAction("of_pick:LEAD-20260824-0042:17")).toEqual({
      action: "of_pick",
      leadId: "LEAD-20260824-0042",
      arg: "17",
    });
  });

  it("round-trips whatever leadActionId builds", () => {
    const id = leadActionId("of_pick", "LEAD-20260824-0042", 17);
    expect(parseLeadAction(id)).toEqual({
      action: "of_pick",
      leadId: "LEAD-20260824-0042",
      arg: "17",
    });
  });

  // The whole point of the guard: a malformed tail must never reach the
  // database from inside the inbound webhook.
  it("rejects a lead id that is not shaped like one", () => {
    expect(parseLeadAction("cb_start:'; DROP TABLE leads--")).toBeNull();
    expect(parseLeadAction("cb_start:abc")).toBeNull(); // too short
    expect(parseLeadAction(`cb_start:${"x".repeat(200)}`)).toBeNull();
    expect(parseLeadAction("cb_start:-LEAD-0001")).toBeNull(); // leading dash
  });

  it("rejects a two-argument action with a non-numeric nbfc id", () => {
    expect(parseLeadAction("of_pick:LEAD-20260824-0042:bajaj")).toBeNull();
    expect(parseLeadAction("of_pick:LEAD-20260824-0042")).toBeNull();
  });

  // Same reasoning as the quotation parser: acting on prose means guessing,
  // and a wrong guess routes a customer's loan to a lender they never chose.
  it("ignores prose that merely mentions the action", () => {
    expect(parseLeadAction("yes please add a co-borrower")).toBeNull();
    expect(parseLeadAction("cb_start")).toBeNull();
    expect(parseLeadAction("")).toBeNull();
    expect(parseLeadAction(null)).toBeNull();
    expect(parseLeadAction(undefined)).toBeNull();
  });

  it("tolerates the whitespace a forwarded tap can carry", () => {
    expect(parseLeadAction("  s4_start:LEAD-20260824-0042  ")).toEqual({
      action: "s4_start",
      leadId: "LEAD-20260824-0042",
    });
  });

  // cb_start and cb_web share a prefix up to the underscore; make sure the
  // longer one is not shadowed by the shorter.
  it("does not confuse actions with overlapping names", () => {
    expect(parseLeadAction("cb_web:LEAD-20260824-0042")?.action).toBe("cb_web");
    expect(parseLeadAction("cb_later:LEAD-20260824-0042")?.action).toBe(
      "cb_later",
    );
    expect(parseLeadAction("s4_web:LEAD-20260824-0042")?.action).toBe("s4_web");
  });

  it("reads the Step-4 extra-documents button", () => {
    expect(parseLeadAction(leadActionId("xd_start", "LEAD-20260824-0042"))).toEqual({
      action: "xd_start",
      leadId: "LEAD-20260824-0042",
    });
  });
});

describe("leadActionId", () => {
  it("stays inside Meta's 200-character list-row id cap", () => {
    const id = leadActionId("of_pick", "L".padEnd(64, "E"), 4294967295);
    expect(id.length).toBeLessThan(200);
  });
});

describe("the real ids we have sent over the wire", () => {
  // Captured verbatim from whatsapp_messages.raw_payload after a live tap, so a
  // regression here means a button we already shipped stops being understood.
  it("parses the document-request button", () => {
    expect(parseLeadAction("dr_send:LEAD-20260824-5beb22cc")).toEqual({
      action: "dr_send",
      leadId: "LEAD-20260824-5beb22cc",
    });
  });
});
