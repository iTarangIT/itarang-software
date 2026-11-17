import { describe, expect, it } from "vitest";

import { LOST_REASON, SALES_LOST_REASONS } from "@/lib/lifecycle/transitions";
import { inNumberRepair } from "../contactabilityLabels";
import { lostReasonWords } from "../lostReasons";

describe("ID 126 — Number Repair 'Repair failed → Lost'", () => {
  const flagged = { contactability: "dead_number", is_active: true, lead_status: "Assigned_Not_Contacted" };

  it("is allowed only on a lead in the Number Repair queue", () => {
    expect(inNumberRepair(flagged)).toBe(true);
    expect(inNumberRepair({ ...flagged, contactability: "non_responsive" })).toBe(true);
    expect(inNumberRepair({ ...flagged, is_active: null })).toBe(true);
    expect(inNumberRepair({ ...flagged, contactability: null })).toBe(false);
    expect(inNumberRepair({ ...flagged, lead_status: "Lost" })).toBe(false);
    expect(inNumberRepair({ ...flagged, is_active: false })).toBe(false);
  });

  it("records 'Number not working', a real sales-lost reason", () => {
    expect(LOST_REASON).toContain("invalid_contact");
    expect(SALES_LOST_REASONS).toContain("invalid_contact");
    expect(lostReasonWords("invalid_contact")).toBe("Number not working");
  });
});
