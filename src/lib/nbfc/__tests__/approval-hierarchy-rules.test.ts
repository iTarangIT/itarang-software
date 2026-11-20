import { describe, expect, it } from "vitest";
import {
  cleanDelegatedSteps,
  decideCibilDecision,
  decideCibilDocRequest,
  decideCibilSubmit,
  decideStep,
  type HierarchyContext,
} from "../approval-hierarchy-rules";

const SALEEM = "saleem";
const ABHISHEK = "abhishek";
const RAJIV = "rajiv";

function child(over: Partial<HierarchyContext> = {}): HierarchyContext {
  return {
    parentUserId: SALEEM,
    parentName: "Saleem",
    delegatedSteps: [],
    gateApplies: true,
    review: null,
    ...over,
  };
}
function parent(over: Partial<HierarchyContext> = {}): HierarchyContext {
  return { parentUserId: null, delegatedSteps: [], gateApplies: true, review: null, ...over };
}
const pending = { status: "pending" as const, submittedBy: ABHISHEK, approverUserId: SALEEM };
const approved = { ...pending, status: "approved" as const };
const rejected = { ...pending, status: "rejected" as const };

describe("child (Abhishek)", () => {
  it("cannot act before sending the CIBIL report", () => {
    expect(decideStep(child(), "kyc").ok).toBe(false);
  });
  it("can send the CIBIL report when none exists", () => {
    expect(decideCibilSubmit(child()).ok).toBe(true);
  });
  it("is locked while the report waits", () => {
    const d = decideStep(child({ review: pending, delegatedSteps: ["kyc"] }), "kyc");
    expect(d.ok).toBe(false);
    expect(!d.ok && d.reason).toMatch(/Waiting for Saleem/);
    expect(decideCibilSubmit(child({ review: pending })).ok).toBe(false);
  });
  it("is view-only after approval unless a step is delegated", () => {
    expect(decideStep(child({ review: approved }), "offer").ok).toBe(false);
    expect(decideStep(child({ review: approved, delegatedSteps: ["offer"] }), "offer").ok).toBe(true);
    expect(decideStep(child({ review: approved, delegatedSteps: ["offer"] }), "fi").ok).toBe(false);
  });
  it("can never reject the file, even with every step delegated", () => {
    expect(decideStep(child({ review: approved, delegatedSteps: cleanDelegatedSteps(["kyc", "docs", "fi", "vkyc", "offer", "sanction", "agreement", "enach"]) }), "reject").ok).toBe(false);
  });
  it("is blocked for good after a rejection", () => {
    expect(decideStep(child({ review: rejected, delegatedSteps: ["kyc"] }), "kyc").ok).toBe(false);
    expect(decideCibilSubmit(child({ review: rejected })).ok).toBe(false);
  });
  it("on a lead from before the switch, only delegated steps", () => {
    expect(decideStep(child({ gateApplies: false, delegatedSteps: ["kyc"] }), "kyc").ok).toBe(true);
    expect(decideStep(child({ gateApplies: false }), "kyc").ok).toBe(false);
  });
});

describe("parent (Saleem) / independent users", () => {
  it("must wait for CIBIL approval when the switch applies", () => {
    expect(decideStep(parent(), "fi").ok).toBe(false);
    expect(decideStep(parent({ review: pending }), "fi").ok).toBe(false);
    expect(decideStep(parent({ review: approved }), "fi").ok).toBe(true);
  });
  it("is unaffected when the switch does not apply", () => {
    expect(decideStep(parent({ gateApplies: false }), "offer").ok).toBe(true);
  });
  it("can always reject the file", () => {
    expect(decideStep(parent({ review: pending }), "reject").ok).toBe(true);
  });
});

describe("who decides a pending report", () => {
  it("the named approver can", () => {
    expect(decideCibilDecision(pending, { userId: SALEEM, role: "nbfc_admin", isChild: false }).ok).toBe(true);
  });
  it("another NBFC admin can cover", () => {
    expect(decideCibilDecision(pending, { userId: RAJIV, role: "nbfc_admin", isChild: false }).ok).toBe(true);
  });
  it("the submitter cannot approve their own report", () => {
    expect(decideCibilDecision(pending, { userId: ABHISHEK, role: "nbfc_admin", isChild: false }).ok).toBe(false);
  });
  it("a non-admin who is not the approver cannot", () => {
    expect(decideCibilDecision(pending, { userId: RAJIV, role: "credit_underwriting", isChild: false }).ok).toBe(false);
  });
  it("nothing to decide once decided", () => {
    expect(decideCibilDecision(approved, { userId: SALEEM, role: "nbfc_admin", isChild: false }).ok).toBe(false);
  });
});

describe("cleanDelegatedSteps", () => {
  it("drops unknown keys, de-duplicates, keeps canonical order", () => {
    expect(cleanDelegatedSteps(["enach", "bogus", "kyc", "kyc"])).toEqual(["kyc", "enach"]);
    expect(cleanDelegatedSteps(null)).toEqual([]);
  });
});

describe("E-389 — ask for documents on a pending CIBIL report", () => {
  it("the parent may raise a document request while the report is pending", () => {
    expect(decideStep(parent({ review: pending }), "docs").ok).toBe(true);
    // ...but nothing else until it is approved
    expect(decideStep(parent({ review: pending }), "offer").ok).toBe(false);
  });
  it("the child stays locked, even with 'docs' delegated", () => {
    expect(decideStep(child({ review: pending, delegatedSteps: ["docs"] }), "docs").ok).toBe(false);
  });
  it("the approver and another NBFC admin may request; the submitter and others may not", () => {
    expect(decideCibilDocRequest(pending, { userId: SALEEM, role: "nbfc_admin", isChild: false }).ok).toBe(true);
    expect(decideCibilDocRequest(pending, { userId: RAJIV, role: "nbfc_admin", isChild: false }).ok).toBe(true);
    expect(decideCibilDocRequest(pending, { userId: ABHISHEK, role: "credit_underwriting", isChild: true }).ok).toBe(false);
    expect(decideCibilDocRequest(pending, { userId: RAJIV, role: "operations", isChild: false }).ok).toBe(false);
  });
  it("not once the report is decided", () => {
    expect(decideCibilDocRequest(approved, { userId: SALEEM, role: "nbfc_admin", isChild: false }).ok).toBe(false);
    expect(decideCibilDocRequest(null, { userId: SALEEM, role: "nbfc_admin", isChild: false }).ok).toBe(false);
  });
});
