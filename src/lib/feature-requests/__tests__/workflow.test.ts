import { describe, expect, it } from "vitest";

import {
  applyAction,
  availableActions,
  canEditRequest,
  devNextStatuses,
  WorkflowError,
  type Actor,
  type Directory,
  type FrState,
  type Status,
} from "../workflow";

const CEO: Actor = { userId: "ceo", seat: "requester" };
const PH: Actor = { userId: "kartik", seat: "product_reviewer" };
const TH: Actor = { userId: "apoorv", seat: "tech_reviewer" };
const DEV1: Actor = { userId: "aditya", seat: "developer" };
const DEV2: Actor = { userId: "rushikesh", seat: "developer" };
const DIR: Directory = { productReviewerId: "kartik", techReviewerId: "apoorv", developerIds: ["aditya", "rushikesh"] };

function fr(status: Status, extra: Partial<FrState> = {}): FrState {
  return {
    status,
    createdBy: "ceo",
    currentOwnerId: null,
    assignedDeveloperId: null,
    resubmitToStatus: null,
    revision: 1,
    ...extra,
  };
}

/** Apply and fold the patch back into the state, like the route does. */
function step(state: FrState, actor: Actor, input: Parameters<typeof applyAction>[2]): FrState {
  const { patch } = applyAction(state, actor, input, DIR);
  return {
    ...state,
    status: patch.status,
    currentOwnerId: patch.currentOwnerId,
    resubmitToStatus: patch.resubmitToStatus,
    assignedDeveloperId: patch.assignedDeveloperId,
    revision: patch.revision,
  };
}

describe("product review", () => {
  const s = fr("pending_product_review", { currentOwnerId: "kartik" });

  it("only the product reviewer has actions", () => {
    expect(availableActions(s, PH)).toEqual(["approve", "request_changes", "reject"]);
    for (const a of [CEO, TH, DEV1]) expect(availableActions(s, a)).toEqual([]);
  });

  it("approve moves to tech review owned by the tech head", () => {
    const r = applyAction(s, PH, { action: "approve" }, DIR);
    expect(r.patch.status).toBe("pending_tech_review");
    expect(r.patch.currentOwnerId).toBe("apoorv");
    expect(r.comment.kind).toBe("approval");
    expect(r.notifyUserIds.sort()).toEqual(["apoorv", "ceo"]);
  });

  it("reject needs a reason and goes back to the CEO", () => {
    expect(() => applyAction(s, PH, { action: "reject", reason: "  " }, DIR)).toThrow(WorkflowError);
    const r = applyAction(s, PH, { action: "reject", reason: "Out of scope" }, DIR);
    expect(r.patch.status).toBe("rejected");
    expect(r.patch.currentOwnerId).toBe("ceo");
    expect(r.comment).toEqual({ kind: "rejection", body: "Out of scope" });
  });

  it("request changes needs a comment and returns to the CEO", () => {
    expect(() => applyAction(s, PH, { action: "request_changes", reason: "" }, DIR)).toThrow(/change/);
    const r = applyAction(s, PH, { action: "request_changes", reason: "Add mockups" }, DIR);
    expect(r.patch).toMatchObject({
      status: "changes_requested",
      currentOwnerId: "ceo",
      resubmitToStatus: "pending_product_review",
    });
  });

  it("the product reviewer cannot send it back to themselves", () => {
    expect(() =>
      applyAction(s, PH, { action: "request_changes", reason: "x", target: "product_reviewer" }, DIR),
    ).toThrow(WorkflowError);
  });

  it("a non-reviewer is refused with 403", () => {
    try {
      applyAction(s, CEO, { action: "approve" }, DIR);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowError);
      expect((e as WorkflowError).status).toBe(403);
    }
  });
});

describe("tech review", () => {
  const s = fr("pending_tech_review", { currentOwnerId: "apoorv" });

  it("approve → ready for assignment", () => {
    expect(applyAction(s, TH, { action: "approve" }, DIR).patch.status).toBe("ready_for_assignment");
  });

  it("can send back to the CEO or to the product head", () => {
    const toCeo = applyAction(s, TH, { action: "request_changes", reason: "x", target: "requester" }, DIR);
    expect(toCeo.patch.currentOwnerId).toBe("ceo");
    const toPh = applyAction(s, TH, { action: "request_changes", reason: "x", target: "product_reviewer" }, DIR);
    expect(toPh.patch.currentOwnerId).toBe("kartik");
    expect(toPh.patch.resubmitToStatus).toBe("pending_tech_review");
    expect(toPh.event.targetUserId).toBe("kartik");
  });

  it("the product reviewer can't act at tech review", () => {
    expect(availableActions(s, PH)).toEqual([]);
  });
});

describe("changes requested → resubmit", () => {
  it("returns to the stage that sent it back, owned by that reviewer", () => {
    let s = fr("pending_tech_review", { currentOwnerId: "apoorv" });
    s = step(s, TH, { action: "request_changes", reason: "clarify", target: "product_reviewer" });
    expect(canEditRequest(s, PH)).toBe(true);
    expect(canEditRequest(s, CEO)).toBe(false);
    expect(availableActions(s, CEO)).toEqual([]);
    s = step(s, PH, { action: "resubmit" });
    expect(s.status).toBe("pending_tech_review");
    expect(s.currentOwnerId).toBe("apoorv");
    expect(s.resubmitToStatus).toBeNull();
  });

  it("CEO resubmit after product review goes back to product review", () => {
    let s = fr("pending_product_review", { currentOwnerId: "kartik" });
    s = step(s, PH, { action: "request_changes", reason: "more detail" });
    s = step(s, CEO, { action: "resubmit" });
    expect(s.status).toBe("pending_product_review");
    expect(s.currentOwnerId).toBe("kartik");
  });
});

describe("reopen", () => {
  it("only the requester reopens, with a note, bumping the revision", () => {
    const s = fr("rejected", { currentOwnerId: "ceo" });
    expect(availableActions(s, PH)).toEqual([]);
    expect(() => applyAction(s, CEO, { action: "reopen", reason: "" }, DIR)).toThrow(WorkflowError);
    const r = applyAction(s, CEO, { action: "reopen", reason: "Rescoped" }, DIR);
    expect(r.patch).toMatchObject({ status: "pending_product_review", currentOwnerId: "kartik", revision: 2 });
  });
});

describe("assignment", () => {
  const s = fr("ready_for_assignment", { currentOwnerId: "apoorv" });

  it("only the tech head assigns, and only an active developer", () => {
    expect(availableActions(s, PH)).toEqual([]);
    expect(() => applyAction(s, TH, { action: "assign", developerId: "kartik" }, DIR)).toThrow(/developer/);
    const r = applyAction(s, TH, { action: "assign", developerId: "aditya" }, DIR);
    expect(r.patch).toMatchObject({ status: "assigned", currentOwnerId: "aditya", assignedDeveloperId: "aditya" });
  });
});

describe("development track", () => {
  it("the assigned developer walks it to closed", () => {
    let s = fr("assigned", { assignedDeveloperId: "aditya", currentOwnerId: "aditya" });
    for (const to of ["in_development", "testing", "ready_for_deployment", "deployed", "closed"] as Status[]) {
      const r = applyAction(s, DEV1, { action: "set_status", toStatus: to }, DIR);
      if (to === "closed") expect(r.patch.closedAt).toBe("now");
      s = step(s, DEV1, { action: "set_status", toStatus: to });
    }
    expect(s.status).toBe("closed");
    expect(availableActions(s, DEV1)).toEqual([]);
  });

  it("the other developer can't change the status", () => {
    const s = fr("in_development", { assignedDeveloperId: "aditya" });
    expect(availableActions(s, DEV2)).toEqual([]);
    expect(() => applyAction(s, DEV2, { action: "set_status", toStatus: "testing" }, DIR)).toThrow(WorkflowError);
  });

  it("no skipping ahead; testing can go back to development", () => {
    const s = fr("testing", { assignedDeveloperId: "aditya" });
    expect(() => applyAction(s, DEV1, { action: "set_status", toStatus: "deployed" }, DIR)).toThrow(WorkflowError);
    expect(devNextStatuses("testing")).toEqual(["ready_for_deployment", "in_development"]);
    expect(applyAction(s, DEV1, { action: "set_status", toStatus: "in_development" }, DIR).patch.status).toBe(
      "in_development",
    );
  });
});

describe("missing seat holders", () => {
  it("approving without an active tech head is refused, not silently ownerless", () => {
    const s = fr("pending_product_review");
    expect(() =>
      applyAction(s, PH, { action: "approve" }, { ...DIR, techReviewerId: null }),
    ).toThrow(/Tech Head/);
  });
});
