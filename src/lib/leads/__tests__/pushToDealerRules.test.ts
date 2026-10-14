// ID 33: button visibility, one-push-per-file, reason, coupon release and the
// finance filter of the dealer picker.
import { describe, expect, it } from "vitest";

import {
  checkPush,
  consentSignedMessage,
  couponOnPush,
  normalizePushReason,
  NOT_HOUSE_MESSAGE,
  pickerDealers,
  pushBlockedReason,
  PUSHED_BEFORE_MESSAGE,
  type PushCheckInput,
} from "../pushToDealer";

const HOUSE = "DLR-HOUSE";
const base = {
  actorRole: "sales_head",
  currentDealerId: HOUSE,
  currentDealerName: "iTarang",
  houseDealerCode: HOUSE,
  consentSigned: false,
  pushedBefore: false,
};

describe("pushBlockedReason (button shown when null)", () => {
  it("shows the button on a house file before consent", () => {
    expect(pushBlockedReason(base)).toBeNull();
    expect(pushBlockedReason({ ...base, actorRole: "admin" })).toBeNull();
  });
  it("hides it after consent, with the agreed message", () => {
    expect(pushBlockedReason({ ...base, consentSigned: true })).toEqual({
      status: 409,
      message: consentSignedMessage("iTarang"),
    });
  });
  it("hides it on a dealer's own lead", () => {
    expect(pushBlockedReason({ ...base, currentDealerId: "DLR-B" })?.message).toBe(NOT_HOUSE_MESSAGE);
    expect(pushBlockedReason({ ...base, actorRole: "admin", currentDealerId: "DLR-B" })?.message).toBe(NOT_HOUSE_MESSAGE);
  });
  it("one push per file: a second move only by an admin", () => {
    const moved = { ...base, currentDealerId: "DLR-B", pushedBefore: true };
    expect(pushBlockedReason(moved)?.message).toBe(PUSHED_BEFORE_MESSAGE);
    expect(pushBlockedReason({ ...moved, actorRole: "admin" })).toBeNull();
    expect(pushBlockedReason({ ...moved, actorRole: "admin", actorIsHouseLogin: true })?.message).toBe(PUSHED_BEFORE_MESSAGE);
  });
  it("a file pushed before stays admin-only even if it is back with the house dealer", () => {
    const back = { ...base, pushedBefore: true };
    expect(pushBlockedReason(back)?.message).toBe(PUSHED_BEFORE_MESSAGE);
    expect(pushBlockedReason({ ...back, actorIsHouseLogin: true, actorRole: "dealer" })?.message).toBe(PUSHED_BEFORE_MESSAGE);
    expect(pushBlockedReason({ ...back, actorRole: "admin" })).toBeNull();
  });
  it("no house dealer configured: nothing is a house file", () => {
    expect(pushBlockedReason({ ...base, houseDealerCode: "", currentDealerId: "" })?.message).toBe(NOT_HOUSE_MESSAGE);
  });
});

describe("checkPush uses the same one-push rule", () => {
  const target = { dealerId: "DLR-A", name: "Acme Motors", financeEnabled: true };
  const input: PushCheckInput = { ...base, paymentMethod: "cash", target };
  it("refuses a second push by a sales head from the house", () => {
    expect(checkPush({ ...input, pushedBefore: true })).toEqual({ ok: false, status: 409, message: PUSHED_BEFORE_MESSAGE });
  });
  it("bulk (house login) never re-moves", () => {
    expect(checkPush({ ...input, actorRole: "dealer", actorIsHouseLogin: true })).toEqual({ ok: true });
    expect(checkPush({ ...input, actorRole: "dealer", actorIsHouseLogin: true, pushedBefore: true }).ok).toBe(false);
  });
});

describe("normalizePushReason", () => {
  it("requires at least 3 characters after trimming", () => {
    expect(normalizePushReason(undefined)).toBeNull();
    expect(normalizePushReason(42)).toBeNull();
    expect(normalizePushReason("  ab ")).toBeNull();
    expect(normalizePushReason("  Dealer is closer to the customer ")).toBe("Dealer is closer to the customer");
  });
  it("cuts over-long text to 500", () => {
    expect(normalizePushReason("x".repeat(900))).toHaveLength(500);
  });
});

describe("couponOnPush", () => {
  it("nothing to do without a coupon", () => {
    expect(couponOnPush(null, null)).toBe("none");
    expect(couponOnPush("  ", "reserved")).toBe("none");
  });
  it("releases a reserved (or half-recorded) coupon back to the old dealer", () => {
    expect(couponOnPush("HOUSE-123", "reserved")).toBe("release");
    expect(couponOnPush("ITARANG-FREE", "reserved")).toBe("release");
    expect(couponOnPush("HOUSE-123", null)).toBe("release");
  });
  it("keeps a used coupon (fee already paid) as a record", () => {
    expect(couponOnPush("HOUSE-123", "used")).toBe("keep_used");
    expect(couponOnPush("HOUSE-123", " USED ")).toBe("keep_used");
  });
});

describe("pickerDealers", () => {
  const list = [
    { dealerId: "A", name: "A", financeEnabled: true },
    { dealerId: "B", name: "B", financeEnabled: false },
  ];
  it("offers every dealer for a cash customer", () => {
    expect(pickerDealers(list)).toHaveLength(2);
  });
  it("offers only finance-enabled dealers when the customer needs a loan", () => {
    expect(pickerDealers(list, { financeOnly: true }).map((d) => d.dealerId)).toEqual(["A"]);
  });
});

describe("14 Oct: the house login re-pushes a file it pushed out", () => {
  const target = { dealerId: "DLR-C", name: "City Motors", financeEnabled: true };
  const withB = { ...base, actorRole: "dealer", actorIsHouseLogin: true, currentDealerId: "DLR-B", currentDealerName: "B Motors", pushedBefore: true };
  it("may push it again to another dealer, wherever it is now", () => {
    expect(pushBlockedReason({ ...withB, houseOriginated: true })).toBeNull();
    expect(checkPush({ ...withB, houseOriginated: true, paymentMethod: "cash", target })).toEqual({ ok: true });
  });
  it("may push it again even when it is back with the house", () => {
    expect(pushBlockedReason({ ...withB, currentDealerId: HOUSE, houseOriginated: true })).toBeNull();
  });
  it("still never after consent", () => {
    expect(pushBlockedReason({ ...withB, houseOriginated: true, consentSigned: true })?.message).toBe(consentSignedMessage("B Motors"));
  });
  it("still not to the dealer it is already with, and finance only to a finance dealer", () => {
    expect(checkPush({ ...withB, houseOriginated: true, paymentMethod: "cash", target: { ...target, dealerId: "DLR-B" } }).ok).toBe(false);
    expect(checkPush({ ...withB, houseOriginated: true, paymentMethod: "finance", target: { ...target, financeEnabled: false } }).ok).toBe(false);
  });
  it("a dealer's own lead (never house-pushed) stays unmovable for the house login", () => {
    expect(pushBlockedReason({ ...withB, pushedBefore: false, houseOriginated: false })?.message).toBe(NOT_HOUSE_MESSAGE);
  });
});
