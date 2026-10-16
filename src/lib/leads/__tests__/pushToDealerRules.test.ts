// ID 33: button visibility, one-push-per-file, reason, coupon release and the
// finance filter of the dealer picker.
import { describe, expect, it } from "vitest";

import {
  checkPush,
  consentSignedMessage,
  couponOnPush,
  isHouseLogin,
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

describe("16 Oct: the house pushes a file once; a second move needs Admin in the CRM", () => {
  const target = { dealerId: "DLR-C", name: "City Motors", financeEnabled: true };
  const withB = { ...base, actorRole: "dealer", actorIsHouseLogin: true, currentDealerId: "DLR-B", currentDealerName: "B Motors", pushedBefore: true };
  it("a house login may not push a file it pushed out again, by any path", () => {
    for (const via of ["bulk_dealer_mobile", "step1_dealer_mobile", "whatsapp_operator", "crm_push"] as const) {
      expect(pushBlockedReason({ ...withB, via })?.message).toBe(PUSHED_BEFORE_MESSAGE);
      expect(checkPush({ ...withB, via, paymentMethod: "cash", target }).ok).toBe(false);
    }
  });
  it("not even when the file is back with the house", () => {
    expect(pushBlockedReason({ ...withB, currentDealerId: HOUSE })?.message).toBe(PUSHED_BEFORE_MESSAGE);
  });
  it("the first push from the house is open to every path", () => {
    for (const via of ["bulk_dealer_mobile", "step1_dealer_mobile", "whatsapp_operator", "crm_push"] as const) {
      expect(checkPush({ ...base, actorRole: "dealer", actorIsHouseLogin: true, via, paymentMethod: "cash", target })).toEqual({ ok: true });
    }
  });
  it("an admin moves it again only through the CRM push", () => {
    const moved = { ...base, actorRole: "admin", currentDealerId: "DLR-B", currentDealerName: "B Motors", pushedBefore: true };
    expect(checkPush({ ...moved, via: "crm_push", paymentMethod: "cash", target })).toEqual({ ok: true });
    expect(checkPush({ ...moved, via: "bulk_dealer_mobile", paymentMethod: "cash", target }).ok).toBe(false);
    expect(checkPush({ ...moved, via: "step1_dealer_mobile", paymentMethod: "cash", target }).ok).toBe(false);
    // a Sales Head never moves it twice
    expect(checkPush({ ...moved, actorRole: "sales_head", via: "crm_push", paymentMethod: "cash", target }).ok).toBe(false);
  });
  it("still never after consent, even for an admin", () => {
    const moved = { ...base, actorRole: "admin", currentDealerId: "DLR-B", currentDealerName: "B Motors", pushedBefore: true, consentSigned: true };
    expect(pushBlockedReason({ ...moved, via: "crm_push" })?.message).toBe(consentSignedMessage("B Motors"));
  });
  it("a dealer's own lead (never pushed) stays unmovable", () => {
    expect(pushBlockedReason({ ...withB, pushedBefore: false })?.message).toBe(NOT_HOUSE_MESSAGE);
  });
});

describe("isHouseLogin (ID 182: every login under the house code)", () => {
  it("any dealer login carrying the house code is a house login", () => {
    expect(isHouseLogin({ role: "dealer", dealerId: HOUSE, houseDealerCode: HOUSE })).toBe(true);
  });
  it("other dealers, other roles and a missing house code are not", () => {
    expect(isHouseLogin({ role: "dealer", dealerId: "DLR-B", houseDealerCode: HOUSE })).toBe(false);
    expect(isHouseLogin({ role: "admin", dealerId: HOUSE, houseDealerCode: HOUSE })).toBe(false);
    expect(isHouseLogin({ role: "dealer", dealerId: "", houseDealerCode: "" })).toBe(false);
    expect(isHouseLogin({ role: "dealer", dealerId: null, houseDealerCode: null })).toBe(false);
  });
});
