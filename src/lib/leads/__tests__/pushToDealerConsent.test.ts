// ID 33: consent gate + push rules + WhatsApp operator answer parsing.
import { describe, expect, it } from "vitest";

import {
  anyConsentSigned,
  canUsePushToDealer,
  checkPush,
  consentSignedMessage,
  isConsentSigned,
  needsLoan,
  parseOperatorDealerAnswer,
  type PushCheckInput,
} from "../pushToDealer";

const HOUSE = "DLR-HOUSE";
const target = { dealerId: "DLR-A", name: "Acme Motors", financeEnabled: true };
const base: PushCheckInput = {
  actorRole: "sales_head",
  currentDealerId: HOUSE,
  currentDealerName: "iTarang",
  houseDealerCode: HOUSE,
  consentSigned: false,
  pushedBefore: false,
  paymentMethod: "cash",
  target,
};

describe("consent gate", () => {
  it("treats every signed state as signed", () => {
    for (const s of ["signed", "esign_completed", "admin_review_pending", "digitally_signed", "manual_uploaded", "verified", " VERIFIED "]) {
      expect(isConsentSigned(s)).toBe(true);
    }
  });
  it("does not block on unsigned, failed or rejected consents", () => {
    for (const s of [null, undefined, "", "pending", "awaiting_signature", "link_sent", "otp_sent", "consent_generated", "esign_failed", "esign_blocked", "expired", "admin_rejected"]) {
      expect(isConsentSigned(s)).toBe(false);
    }
    expect(anyConsentSigned(["pending", null, "link_sent"])).toBe(false);
    expect(anyConsentSigned(["pending", "esign_completed"])).toBe(true);
  });
  it("uses the exact agreed message", () => {
    expect(consentSignedMessage("Acme Motors")).toBe(
      "Consent is already signed under Acme Motors; this file can't be moved.",
    );
  });
  it("refuses a push once consent is signed — even for an admin re-move", () => {
    const r = checkPush({ ...base, consentSigned: true });
    expect(r).toEqual({ ok: false, status: 409, message: consentSignedMessage("iTarang") });
    const again = checkPush({ ...base, actorRole: "admin", currentDealerId: "DLR-B", currentDealerName: "Bharat EV", pushedBefore: true, consentSigned: true });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.message).toBe(consentSignedMessage("Bharat EV"));
  });
});

describe("checkPush", () => {
  it("allows the first push of a house file", () => {
    expect(checkPush(base)).toEqual({ ok: true });
  });
  it("one push per file: a second move only by an admin", () => {
    const moved = { ...base, currentDealerId: "DLR-B", pushedBefore: true };
    expect(checkPush(moved).ok).toBe(false);
    expect(checkPush({ ...moved, actorRole: "admin" })).toEqual({ ok: true });
    // the house-dealer login path never re-moves, whatever the role says
    expect(checkPush({ ...moved, actorRole: "admin", actorIsHouseLogin: true }).ok).toBe(false);
  });
  it("never moves a dealer's own lead (no push before)", () => {
    const own = checkPush({ ...base, actorRole: "admin", currentDealerId: "DLR-B", pushedBefore: false });
    expect(own.ok).toBe(false);
  });
  it("refuses a push to the dealer it is already with", () => {
    expect(checkPush({ ...base, actorRole: "admin", currentDealerId: "DLR-A", pushedBefore: true }).ok).toBe(false);
  });
  it("finance customers only to finance-enabled dealers", () => {
    const cashDealer = { ...target, financeEnabled: false };
    expect(checkPush({ ...base, paymentMethod: "finance", target: cashDealer })).toMatchObject({ ok: false, status: 422 });
    expect(checkPush({ ...base, paymentMethod: "other_finance", target: cashDealer }).ok).toBe(false);
    expect(checkPush({ ...base, paymentMethod: "cash", target: cashDealer }).ok).toBe(true);
    expect(needsLoan("dealer_finance")).toBe(true);
    expect(needsLoan(null)).toBe(false);
  });
});

describe("CRM roles (8 Oct): Admin and Sales Head only", () => {
  it("admits admin and sales_head, not the other internal roles", () => {
    expect(canUsePushToDealer({ role: "admin", dealerId: null, houseDealerCode: HOUSE })).toBe(true);
    expect(canUsePushToDealer({ role: "sales_head", dealerId: null, houseDealerCode: HOUSE })).toBe(true);
    for (const role of ["ceo", "business_head", "sales_manager", "partner"]) {
      expect(canUsePushToDealer({ role, dealerId: null, houseDealerCode: HOUSE })).toBe(false);
    }
    // the house-dealer login keeps working
    expect(canUsePushToDealer({ role: "dealer", dealerId: HOUSE, houseDealerCode: HOUSE })).toBe(true);
  });
});

describe("parseOperatorDealerAnswer", () => {
  it("reads Skip (button or word)", () => {
    expect(parseOperatorDealerAnswer("op_cust_skip")).toEqual({ kind: "skip" });
    expect(parseOperatorDealerAnswer(" Skip ")).toEqual({ kind: "skip" });
  });
  it("reads a mobile", () => {
    expect(parseOperatorDealerAnswer("+91 98765 43210")).toEqual({ kind: "mobile", mobile: "9876543210" });
  });
  it("flags anything else", () => {
    expect(parseOperatorDealerAnswer("acme")).toEqual({ kind: "invalid" });
    expect(parseOperatorDealerAnswer(undefined)).toEqual({ kind: "invalid" });
  });
});
