import { describe, expect, it } from "vitest";
import {
  LOT_STATUSES,
  CANCELLABLE_LOT_STATUSES,
  OPEN_LOT_STATUSES,
  CLOSED_LOT_STATUSES,
  FINISHED_LOT_STATUSES,
  allOpenItemsCosted,
  allOpenItemsReady,
  assertLotMove,
  awaitingParty,
  balanceClearedForReturn,
  custodyForItem,
  moveParty,
  nextAfterReceipt,
  nextLotStatus,
  partyMayMove,
  shippableOut,
  splitMargin,
} from "../refurbishment-lot-status";

describe("refurbishment lot status machine (E-292, v3)", () => {
  it("walks the long path: counter, PI, advance, pickup, refurbisher, margin, balance, close", () => {
    let s = "requested";
    const walk = (move: Parameters<typeof assertLotMove>[1], to: string) => {
      s = assertLotMove(s, move);
      expect(s).toBe(to);
    };
    walk("review", "reviewed");
    walk("review", "reviewed"); // re-entrant: a second pass of declines
    walk("estimate", "estimated");
    walk("counter", "countered");
    walk("estimate", "estimated");
    walk("accept", "agreed");
    walk("send_pi", "pi_sent");
    walk("send_pi", "pi_sent"); // corrected PDF before acceptance
    walk("accept_pi", "pi_accepted");
    walk("advance_received", "advance_recorded");
    walk("pickup", "in_transit_out");
    walk("receive_out", "received"); // "arrived" is a timestamp, not a state
    walk("assign", "at_refurbisher");
    walk("assign", "at_refurbisher"); // re-assign before work starts
    walk("start_work", "in_progress");
    walk("all_costed", "costed");
    walk("all_ready", "ready");
    walk("dispatch_return", "in_transit_return");
    walk("arrive_return", "delivered_back");
    walk("receive_return", "balance_due");
    walk("settle", "settled");
    walk("close", "closed");
  });

  it("walks the lean path: no advance, NBFC ships, nothing owed at the end", () => {
    expect(nextLotStatus("pi_accepted", "dispatch_out")).toBe("in_transit_out");
    expect(shippableOut({ status: "pi_accepted", advance_status: "not_required" })).toBe(true);
    expect(shippableOut({ status: "pi_accepted", advance_status: "pending" })).toBe(false);
    expect(shippableOut({ status: "pi_accepted", advance_status: "recorded" })).toBe(false);
    expect(shippableOut({ status: "advance_recorded", advance_status: "confirmed" })).toBe(true);
    expect(shippableOut({ status: "agreed" })).toBe(false);
    expect(nextAfterReceipt(0)).toBe("settled");
    expect(nextAfterReceipt(null)).toBe("settled");
    expect(nextAfterReceipt(1200)).toBe("balance_due");
  });

  it("E-293: the balance is paid before the return truck — a confirmed balance settles on receipt, a pending one holds the truck", () => {
    // paid (confirmed) while the batteries were still away → receipt settles the lot
    expect(nextAfterReceipt(1200, "confirmed")).toBe("settled");
    // merely recorded (slip + UTR) → iTarang still owes the confirmation after receipt
    expect(nextAfterReceipt(1200, "recorded")).toBe("balance_due");
    expect(nextAfterReceipt(1200, "pending")).toBe("balance_due");
    // the return dispatch gate
    expect(balanceClearedForReturn({ balance_status: "pending" })).toBe(false);
    expect(balanceClearedForReturn({ balance_status: "recorded" })).toBe(true);
    expect(balanceClearedForReturn({ balance_status: "confirmed" })).toBe(true);
    expect(balanceClearedForReturn({ balance_status: "not_due" })).toBe(true);
    expect(balanceClearedForReturn({})).toBe(true);
    // who is waited on while the lot is ready
    expect(awaitingParty("ready", { balance_status: "pending" })).toBe("nbfc");
    expect(awaitingParty("ready", { balance_status: "recorded" })).toBe("admin");
    expect(awaitingParty("ready", { balance_status: "confirmed" })).toBe("admin");
    expect(awaitingParty("ready")).toBe("admin");
  });

  it("refuses moves out of order", () => {
    expect(nextLotStatus("requested", "estimate")).toBeNull(); // must review first
    expect(nextLotStatus("requested", "accept")).toBeNull();
    expect(nextLotStatus("estimated", "send_pi")).toBeNull(); // must be agreed first
    expect(nextLotStatus("agreed", "dispatch_out")).toBeNull(); // PI not accepted
    expect(nextLotStatus("pi_sent", "dispatch_out")).toBeNull();
    expect(nextLotStatus("in_transit_return", "receive_return")).toBeNull(); // must arrive first
    expect(nextLotStatus("in_progress", "all_ready")).toBeNull(); // must be costed first
    expect(nextLotStatus("received", "start_work")).toBeNull(); // must be assigned first
    expect(nextLotStatus("in_progress", "dispatch_return")).toBeNull();
    expect(nextLotStatus("balance_due", "close")).toBeNull(); // must settle first
    expect(nextLotStatus("closed", "close")).toBeNull();
    expect(() => assertLotMove("received", "accept")).toThrow(/^CONFLICT:/);
  });

  it("allows cancel only before anything has moved, by nbfc or admin only", () => {
    for (const s of CANCELLABLE_LOT_STATUSES) expect(nextLotStatus(s, "cancel")).toBe("cancelled");
    for (const s of ["in_transit_out", "received", "at_refurbisher", "in_progress", "costed", "ready", "in_transit_return", "delivered_back", "balance_due", "settled", "closed", "cancelled"]) {
      expect(nextLotStatus(s, "cancel")).toBeNull();
    }
    expect(moveParty("cancel")).toEqual(["nbfc", "admin"]);
    expect(partyMayMove("refurbisher", "cancel")).toBe(false);
  });

  it("knows which party performs which move", () => {
    expect(partyMayMove("refurbisher", "start_work")).toBe(true);
    expect(partyMayMove("admin", "start_work")).toBe(true); // admin override
    expect(partyMayMove("nbfc", "start_work")).toBe(false);
    expect(partyMayMove("refurbisher", "dispatch_return")).toBe(true);
    expect(partyMayMove("refurbisher", "send_pi")).toBe(false);
    expect(partyMayMove("nbfc", "close")).toBe(true);
    expect(moveParty("all_costed")).toBe("system");
    expect(partyMayMove("admin", "all_costed")).toBe(false);
  });

  it("names who owes the next move, including the money sub-states and the refurbisher", () => {
    expect(awaitingParty("requested")).toBe("admin");
    expect(awaitingParty("reviewed")).toBe("admin");
    expect(awaitingParty("estimated")).toBe("nbfc");
    expect(awaitingParty("countered")).toBe("admin");
    expect(awaitingParty("agreed")).toBe("admin");
    expect(awaitingParty("pi_sent")).toBe("nbfc");
    expect(awaitingParty("pi_accepted", { advance_status: "pending" })).toBe("nbfc");
    expect(awaitingParty("pi_accepted", { advance_status: "recorded" })).toBe("admin");
    expect(awaitingParty("pi_accepted", { advance_status: "not_required", pickup_mode: "nbfc_ships" })).toBe("nbfc");
    expect(awaitingParty("pi_accepted", { advance_status: "not_required", pickup_mode: "itarang_pickup" })).toBe("admin");
    expect(awaitingParty("advance_recorded", { pickup_mode: "nbfc_ships" })).toBe("nbfc");
    expect(awaitingParty("advance_recorded", { pickup_mode: "itarang_pickup" })).toBe("admin");
    expect(awaitingParty("in_transit_out")).toBe("admin");
    expect(awaitingParty("received")).toBe("admin");
    expect(awaitingParty("at_refurbisher")).toBe("refurbisher");
    expect(awaitingParty("in_progress")).toBe("refurbisher");
    expect(awaitingParty("costed")).toBe("admin");
    expect(awaitingParty("ready")).toBe("admin");
    expect(awaitingParty("delivered_back")).toBe("nbfc");
    expect(awaitingParty("balance_due", { balance_status: "pending" })).toBe("nbfc");
    expect(awaitingParty("balance_due", { balance_status: "recorded" })).toBe("admin");
    expect(awaitingParty("settled")).toBe("nbfc"); // owes the redeploy / auction choice
    expect(awaitingParty("closed")).toBeNull();
    expect(awaitingParty("cancelled")).toBeNull();
  });

  it("keeps the open/closed split total and settled open", () => {
    expect(new Set([...OPEN_LOT_STATUSES, ...CLOSED_LOT_STATUSES]).size).toBe(LOT_STATUSES.length);
    expect(LOT_STATUSES.length).toBe(20);
    expect(OPEN_LOT_STATUSES).toContain("settled");
    expect(FINISHED_LOT_STATUSES).toEqual(["settled", "closed", "cancelled"]);
  });

  it("only calls a lot ready / costed when every live battery is", () => {
    expect(allOpenItemsReady([])).toBe(false);
    expect(allOpenItemsReady(["ready", "ready"])).toBe(true);
    expect(allOpenItemsReady(["ready", "at_refurbisher"])).toBe(false);
    expect(allOpenItemsReady(["ready", "declined", "cancelled"])).toBe(true);
    expect(allOpenItemsReady(["declined"])).toBe(false);
    expect(allOpenItemsReady(["returned", "ready"])).toBe(true);
    expect(allOpenItemsCosted([])).toBe(false);
    expect(allOpenItemsCosted([{ status: "at_refurbisher", costed_at: "x" }, { status: "declined" }])).toBe(true);
    expect(allOpenItemsCosted([{ status: "at_refurbisher", costed_at: "x" }, { status: "at_refurbisher", costed_at: null }])).toBe(false);
  });

  it("splits the margin pro-rata and sums exactly to the final total", () => {
    expect(splitMargin([4200 + 7500, 7800 + 7500], 4050)).toEqual([11700 + 1755, 15300 + 2295]);
    const out = splitMargin([100, 100, 100], 10);
    expect(out.reduce((s, x) => s + x, 0)).toBeCloseTo(310, 2);
    expect(splitMargin([0, 0], 100)).toEqual([50, 50]);
    expect(splitMargin([1000], 0)).toEqual([1000]);
    expect(splitMargin([], 100)).toEqual([]);
  });

  it("derives where a battery is from lot status + its own receipt facts", () => {
    const j = (status: string, extra: Record<string, string | null> = {}) => ({ status, ...extra });
    const L = (status: string, extra: Record<string, string | null> = {}) => ({ status, ...extra });
    expect(custodyForItem(L("requested"), j("requested"))).toBe("with_nbfc");
    expect(custodyForItem(L("pi_sent"), j("requested"))).toBe("with_nbfc");
    expect(custodyForItem(L("pi_accepted", { advance_status: "pending", pickup_mode: "itarang_pickup" }), j("requested"))).toBe("with_nbfc");
    expect(custodyForItem(L("advance_recorded", { advance_status: "confirmed", pickup_mode: "itarang_pickup" }), j("requested"))).toBe("awaiting_pickup");
    expect(custodyForItem(L("advance_recorded", { advance_status: "confirmed", pickup_mode: "nbfc_ships" }), j("requested"))).toBe("with_nbfc");
    expect(custodyForItem(L("in_transit_out"), j("requested"))).toBe("in_transit_to_itarang");
    expect(custodyForItem(L("received"), j("requested"))).toBe("at_itarang");
    expect(custodyForItem(L("at_refurbisher"), j("at_refurbisher"))).toBe("at_refurbisher");
    expect(custodyForItem(L("in_progress"), j("at_refurbisher"))).toBe("at_refurbisher");
    expect(custodyForItem(L("costed"), j("at_refurbisher"))).toBe("at_refurbisher");
    expect(custodyForItem(L("ready"), j("ready"))).toBe("at_refurbisher");
    expect(custodyForItem(L("in_progress"), j("requested", { out_received_condition: "missing" }))).toBe("unknown_lost");
    expect(custodyForItem(L("in_progress"), j("cancelled", { out_received_condition: "missing" }))).toBe("unknown_lost");
    expect(custodyForItem(L("in_transit_return"), j("ready"))).toBe("in_transit_to_nbfc");
    expect(custodyForItem(L("delivered_back"), j("ready"))).toBe("at_nbfc_gate");
    expect(custodyForItem(L("balance_due"), j("returned"))).toBe("back_with_nbfc");
    expect(custodyForItem(L("settled"), j("returned"))).toBe("back_with_nbfc");
    expect(custodyForItem(L("closed"), j("returned"))).toBe("back_with_nbfc");
    // a declined battery never left the NBFC, whatever the lot went on to do
    expect(custodyForItem(L("in_transit_out"), j("declined"))).toBe("with_nbfc");
  });
});
