import { describe, expect, it } from "vitest";
import {
  LOT_STATUSES,
  CANCELLABLE_LOT_STATUSES,
  OPEN_LOT_STATUSES,
  CLOSED_LOT_STATUSES,
  allOpenItemsReady,
  assertLotMove,
  awaitingParty,
  custodyForItem,
  moveParty,
  nextAfterAdvance,
  nextAfterAgreed,
  nextAfterReceipt,
  nextLotStatus,
  withinApprovedQuote,
} from "../refurbishment-lot-status";

describe("refurbishment lot status machine (E-270 / E-271)", () => {
  it("walks the full happy path: advance + iTarang pickup + revision + balance", () => {
    let s = "requested";
    const walk = (move: Parameters<typeof assertLotMove>[1], to: string) => {
      s = assertLotMove(s, move);
      expect(s).toBe(to);
    };
    walk("propose", "proposed");
    walk("counter", "countered");
    walk("propose", "proposed");
    walk("accept", "agreed");
    // accept lands on awaiting_advance when the quote carries an advance
    s = nextAfterAgreed({ advance_pct: 30, pickup_mode: "itarang_pickup" });
    expect(s).toBe("awaiting_advance");
    walk("advance_paid", "advance_paid");
    s = nextAfterAdvance({ pickup_mode: "itarang_pickup" });
    expect(s).toBe("pickup_scheduled");
    walk("pickup", "in_transit_out");
    walk("arrive_out", "delivered");
    walk("receive_out", "received");
    walk("start_work", "in_progress");
    walk("revise", "revision_pending");
    walk("reject_revision", "in_progress");
    walk("revise", "revision_pending");
    walk("approve_revision", "in_progress");
    walk("all_ready", "ready");
    walk("dispatch_return", "in_transit_return");
    walk("arrive_return", "delivered_back");
    walk("receive_return", "balance_due");
    walk("settle", "settled");
  });

  it("walks the lean path: no advance, NBFC ships, nothing owed at the end", () => {
    expect(nextAfterAgreed({ advance_pct: 0, pickup_mode: "nbfc_ships" })).toBe("agreed");
    expect(nextLotStatus("agreed", "dispatch_out")).toBe("in_transit_out");
    expect(nextAfterReceipt(0)).toBe("settled");
    expect(nextAfterReceipt(null)).toBe("settled");
    expect(nextAfterReceipt(1200)).toBe("balance_due");
  });

  it("routes agreed → pickup_scheduled when iTarang collects and no advance is due", () => {
    expect(nextAfterAgreed({ advance_pct: 0, pickup_mode: "itarang_pickup" })).toBe("pickup_scheduled");
    expect(nextAfterAdvance({ pickup_mode: "nbfc_ships" })).toBe("advance_paid");
    expect(nextLotStatus("advance_paid", "dispatch_out")).toBe("in_transit_out");
    expect(nextLotStatus("pickup_scheduled", "dispatch_out")).toBeNull(); // NBFC cannot ship a pickup lot
    expect(nextLotStatus("agreed", "pickup")).toBeNull(); // and iTarang cannot pick up an nbfc_ships lot
  });

  it("refuses moves out of order", () => {
    expect(nextLotStatus("requested", "accept")).toBeNull();
    expect(nextLotStatus("requested", "dispatch_out")).toBeNull();
    expect(nextLotStatus("proposed", "propose")).toBeNull();
    expect(nextLotStatus("in_transit_out", "receive_out")).toBeNull(); // must arrive first
    expect(nextLotStatus("in_transit_return", "receive_return")).toBeNull();
    expect(nextLotStatus("in_progress", "dispatch_return")).toBeNull();
    expect(nextLotStatus("ready", "revise")).toBeNull();
    expect(nextLotStatus("settled", "cancel")).toBeNull();
    expect(() => assertLotMove("received", "accept")).toThrow(/^CONFLICT:/);
  });

  it("allows cancel only before anything has moved", () => {
    for (const s of CANCELLABLE_LOT_STATUSES) expect(nextLotStatus(s, "cancel")).toBe("cancelled");
    for (const s of ["in_transit_out", "delivered", "received", "in_progress", "revision_pending", "ready", "in_transit_return", "delivered_back", "balance_due", "settled", "cancelled"]) {
      expect(nextLotStatus(s, "cancel")).toBeNull();
    }
    expect(moveParty("cancel")).toBe("either");
  });

  it("names who owes the next move, including the money sub-states", () => {
    expect(awaitingParty("requested")).toBe("admin");
    expect(awaitingParty("proposed")).toBe("nbfc");
    expect(awaitingParty("pickup_scheduled")).toBe("admin");
    expect(awaitingParty("advance_paid")).toBe("nbfc");
    expect(awaitingParty("delivered")).toBe("admin");
    expect(awaitingParty("revision_pending")).toBe("nbfc");
    expect(awaitingParty("delivered_back")).toBe("nbfc");
    expect(awaitingParty("awaiting_advance", { advance_status: "pending" })).toBe("nbfc");
    expect(awaitingParty("awaiting_advance", { advance_status: "recorded" })).toBe("admin");
    expect(awaitingParty("balance_due", { balance_status: "pending" })).toBe("nbfc");
    expect(awaitingParty("balance_due", { balance_status: "recorded" })).toBe("admin");
    expect(awaitingParty("settled")).toBeNull();
    expect(awaitingParty("cancelled")).toBeNull();
  });

  it("keeps the open/closed split total", () => {
    expect(new Set([...OPEN_LOT_STATUSES, ...CLOSED_LOT_STATUSES]).size).toBe(LOT_STATUSES.length);
    expect(LOT_STATUSES.length).toBe(18);
  });

  it("only calls a lot ready when every live battery is", () => {
    expect(allOpenItemsReady([])).toBe(false);
    expect(allOpenItemsReady(["ready", "ready"])).toBe(true);
    expect(allOpenItemsReady(["ready", "in_progress"])).toBe(false);
    expect(allOpenItemsReady(["ready", "declined", "cancelled"])).toBe(true);
    expect(allOpenItemsReady(["declined"])).toBe(false);
    expect(allOpenItemsReady(["returned", "ready"])).toBe(true);
  });

  it("gates ready on the approved quote", () => {
    expect(withinApprovedQuote(23000, 23000)).toBe(true);
    expect(withinApprovedQuote(23000.004, 23000)).toBe(true);
    expect(withinApprovedQuote(23001, 23000)).toBe(false);
    expect(withinApprovedQuote(99999, null)).toBe(true); // legacy lots without a frozen quote
    expect(withinApprovedQuote(null, 100)).toBe(true);
  });

  it("derives where a battery is from lot status + its own receipt facts", () => {
    const j = (status: string, extra: Record<string, string | null> = {}) => ({ status, ...extra });
    expect(custodyForItem("requested", j("requested"))).toBe("at_nbfc");
    expect(custodyForItem("awaiting_advance", j("requested"))).toBe("at_nbfc");
    expect(custodyForItem("pickup_scheduled", j("requested"))).toBe("awaiting_pickup");
    expect(custodyForItem("in_transit_out", j("requested"))).toBe("in_transit_to_workshop");
    expect(custodyForItem("delivered", j("requested"))).toBe("at_workshop_gate");
    expect(custodyForItem("received", j("requested"))).toBe("at_workshop");
    expect(custodyForItem("in_progress", j("in_progress"))).toBe("at_workshop");
    expect(custodyForItem("in_progress", j("requested", { out_received_condition: "missing" }))).toBe("unknown_lost");
    expect(custodyForItem("in_progress", j("cancelled", { out_received_condition: "missing" }))).toBe("unknown_lost");
    expect(custodyForItem("in_transit_return", j("ready"))).toBe("in_transit_to_nbfc");
    expect(custodyForItem("delivered_back", j("ready"))).toBe("at_nbfc_gate");
    expect(custodyForItem("balance_due", j("returned"))).toBe("back_at_nbfc");
    expect(custodyForItem("settled", j("returned"))).toBe("back_at_nbfc");
    // a declined battery never left the NBFC, whatever the lot went on to do
    expect(custodyForItem("in_transit_out", j("declined"))).toBe("at_nbfc");
  });
});
