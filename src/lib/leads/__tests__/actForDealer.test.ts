// ID 183: who may act for the dealer, the 30-minute "being worked by" note,
// dealer-wins and the one-live-consent-OTP rule.
import { describe, expect, it } from "vitest";

import {
  actForDealerPermission,
  consentOtpResendBlocked,
  DEALER_ACTIVE_MESSAGE,
  DEALER_ONLY_MESSAGE,
  dealerChangedSince,
  doneByLine,
  isActForDealerRole,
  isLockLive,
  leadActorVerdict,
  lockVerdict,
  parseSeenHeader,
  WRITE_REFUSED_MESSAGE,
} from "../actForDealer";

const NONE = new Set<string>();
// IST instants: 2026-10-12 is a Monday, 2026-10-18 a Sunday.
const ist = (s: string) => new Date(`${s}+05:30`);

describe("isActForDealerRole", () => {
  it("Admin and Sales Head only", () => {
    expect(isActForDealerRole("admin")).toBe(true);
    expect(isActForDealerRole("sales_head")).toBe(true);
    for (const r of ["ceo", "sales_manager", "sales_executive", "business_head", "finance_controller", "dealer", null]) {
      expect(isActForDealerRole(r)).toBe(false);
    }
  });
});

describe("actForDealerPermission", () => {
  const base = { housePushed: false, dealerAsked: false, holidays: NONE };
  it("house-pushed files any time, even right after the dealer acted", () => {
    const at = ist("2026-10-12T10:00:00");
    expect(actForDealerPermission({ ...base, housePushed: true, lastDealerActionAt: at, now: at })).toEqual({ ok: true, ground: "house_pushed" });
  });
  it("the dealer's own file: refused the same day and the next working day", () => {
    const at = ist("2026-10-12T10:00:00");
    expect(actForDealerPermission({ ...base, lastDealerActionAt: at, now: ist("2026-10-12T18:00:00") })).toEqual({ ok: false, message: DEALER_ACTIVE_MESSAGE });
    expect(actForDealerPermission({ ...base, lastDealerActionAt: at, now: ist("2026-10-13T23:00:00") }).ok).toBe(false);
  });
  it("…and allowed once a whole working day passed with no dealer action", () => {
    const at = ist("2026-10-12T10:00:00");
    expect(actForDealerPermission({ ...base, lastDealerActionAt: at, now: ist("2026-10-14T00:30:00") })).toEqual({ ok: true, ground: "dealer_idle" });
  });
  it("Sunday and holidays are not working days", () => {
    const sat = ist("2026-10-17T10:00:00");
    // Sunday 18th is skipped, Monday 19th is the working day that must pass.
    expect(actForDealerPermission({ ...base, lastDealerActionAt: sat, now: ist("2026-10-19T20:00:00") }).ok).toBe(false);
    expect(actForDealerPermission({ ...base, lastDealerActionAt: sat, now: ist("2026-10-20T09:00:00") }).ok).toBe(true);
    const holidays = new Set(["2026-10-19"]);
    expect(actForDealerPermission({ ...base, holidays, lastDealerActionAt: sat, now: ist("2026-10-20T09:00:00") }).ok).toBe(false);
  });
  it("the dealer asked for help: any time", () => {
    const at = ist("2026-10-12T10:00:00");
    expect(actForDealerPermission({ ...base, dealerAsked: true, lastDealerActionAt: at, now: at })).toEqual({ ok: true, ground: "dealer_asked" });
  });
  it("no known dealer action counts as idle", () => {
    expect(actForDealerPermission({ ...base, lastDealerActionAt: null, now: ist("2026-10-12T10:00:00") }).ok).toBe(true);
  });
});

describe("lockVerdict (30-minute 'being worked by')", () => {
  const now = ist("2026-10-12T10:00:00");
  const live = { holderUserId: "u-anirudh", holderName: "Anirudh", expiresAt: ist("2026-10-12T10:20:00") };
  it("the dealer always wins and clears the note", () => {
    expect(lockVerdict({ lock: live, actorUserId: "u-dealer", actorKind: "dealer", now })).toEqual({ ok: true, action: "clear" });
  });
  it("a second iTarang person is refused while the note is live, with name and time", () => {
    const v = lockVerdict({ lock: live, actorUserId: "u-other", actorKind: "itarang", now });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toMatch(/being worked by Anirudh until/);
    expect(lockVerdict({ lock: live, actorUserId: "u-other", actorKind: "house", now }).ok).toBe(false);
  });
  it("the holder refreshes their own note", () => {
    expect(lockVerdict({ lock: live, actorUserId: "u-anirudh", actorKind: "itarang", now })).toEqual({ ok: true, action: "refresh" });
  });
  it("an expired or empty note is free", () => {
    const expired = { ...live, expiresAt: ist("2026-10-12T09:59:00") };
    expect(isLockLive(expired, now)).toBe(false);
    expect(lockVerdict({ lock: expired, actorUserId: "u-other", actorKind: "itarang", now })).toEqual({ ok: true, action: "acquire" });
    expect(lockVerdict({ lock: null, actorUserId: "u-other", actorKind: "itarang", now })).toEqual({ ok: true, action: "acquire" });
    expect(lockVerdict({ lock: { holderUserId: null, holderName: null, expiresAt: null }, actorUserId: "u", actorKind: "itarang", now }).ok).toBe(true);
  });
});

describe("dealerChangedSince (dealer wins a save clash)", () => {
  const dealerAt = ist("2026-10-12T10:00:00");
  it("refuses a save on a copy older than the dealer's last action", () => {
    expect(dealerChangedSince(dealerAt, ist("2026-10-12T09:00:00"))).toBe(true);
    expect(dealerChangedSince(dealerAt, null)).toBe(true);
  });
  it("passes when the panel saw that action, or does not track it", () => {
    expect(dealerChangedSince(dealerAt, dealerAt)).toBe(false);
    expect(dealerChangedSince(dealerAt, undefined)).toBe(false);
    expect(dealerChangedSince(null, null)).toBe(false);
  });
  it("parses the panel header", () => {
    expect(parseSeenHeader(null)).toBeUndefined();
    expect(parseSeenHeader("none")).toBeNull();
    expect(parseSeenHeader("2026-10-12T04:30:00.000Z")?.toISOString()).toBe("2026-10-12T04:30:00.000Z");
    expect(parseSeenHeader("garbage")).toBeUndefined();
  });
});

describe("consentOtpResendBlocked (one live consent OTP at a time)", () => {
  const now = ist("2026-10-12T10:00:00");
  const live = { requestedBy: "u-dealer", requestedByName: "Acme Motors", expiresAt: ist("2026-10-12T10:05:00") };
  it("refuses iTarang while someone else's code is live", () => {
    expect(consentOtpResendBlocked({ live, requesterId: "u-admin", requesterIsItarang: true, now })).toMatch(/sent by Acme Motors is still live/);
  });
  it("lets the dealer resend (dealer wins) and the sender resend their own", () => {
    expect(consentOtpResendBlocked({ live, requesterId: "u-dealer2", requesterIsItarang: false, now })).toBeNull();
    expect(consentOtpResendBlocked({ live: { ...live, requestedBy: "u-admin" }, requesterId: "u-admin", requesterIsItarang: true, now })).toBeNull();
  });
  it("an expired code or none blocks nothing", () => {
    expect(consentOtpResendBlocked({ live: { ...live, expiresAt: ist("2026-10-12T09:00:00") }, requesterId: "u-admin", requesterIsItarang: true, now })).toBeNull();
    expect(consentOtpResendBlocked({ live: null, requesterId: "u-admin", requesterIsItarang: true, now })).toBeNull();
  });
});

describe("doneByLine", () => {
  it("names the person and the dealer", () => {
    expect(doneByLine("Anirudh", "Acme Motors")).toBe("Done by Anirudh for Acme Motors");
    expect(doneByLine(null, "")).toBe("Done by iTarang for the dealer");
  });
});

describe("leadActorVerdict — who may write on a customer file (16 Oct)", () => {
  const base = { ownsFile: false, houseOnPushedFile: false, write: true, dispatch: false };

  it("the file's own dealer writes, dispatch included", () => {
    expect(leadActorVerdict({ ...base, role: "dealer", ownsFile: true })).toEqual({ ok: true, kind: "dealer" });
    expect(leadActorVerdict({ ...base, role: "dealer", ownsFile: true, dispatch: true })).toEqual({ ok: true, kind: "dealer" });
  });

  // 16 Oct evening (user): the house keeps FULL access on a file it pushed
  // out — read, write and dispatch, like the file's dealer.
  it("the house login works every step of a file it pushed to another dealer, dispatch included", () => {
    const house = { ...base, role: "dealer", houseOnPushedFile: true };
    expect(leadActorVerdict({ ...house, write: false })).toEqual({ ok: true, kind: "house" });
    expect(leadActorVerdict(house)).toEqual({ ok: true, kind: "house" });
    expect(leadActorVerdict({ ...house, dispatch: true })).toEqual({ ok: true, kind: "house" });
  });

  it("the house still fully works a file that is with the house (it owns it)", () => {
    expect(leadActorVerdict({ ...base, role: "dealer", ownsFile: true, houseOnPushedFile: false })).toEqual({ ok: true, kind: "dealer" });
  });

  it("another dealer is refused", () => {
    expect(leadActorVerdict({ ...base, role: "dealer" }).ok).toBe(false);
    expect(leadActorVerdict({ ...base, role: "dealer", write: false }).ok).toBe(false);
  });

  it("Admin and Sales Head go through act-for-dealer, never dispatch", () => {
    for (const role of ["admin", "sales_head", "ADMIN"]) {
      expect(leadActorVerdict({ ...base, role })).toEqual({ ok: true, kind: "itarang" });
      expect(leadActorVerdict({ ...base, role, dispatch: true })).toEqual({ ok: false, status: 403, message: DEALER_ONLY_MESSAGE });
    }
  });

  it("the CEO, other back-office roles and placeholders are refused for writes", () => {
    for (const role of ["ceo", "business_head", "sales_manager", "sales_executive", "finance_controller", "partner", "user", "", null]) {
      expect(leadActorVerdict({ ...base, role }), String(role)).toEqual({ ok: false, status: 403, message: WRITE_REFUSED_MESSAGE });
      // Even if the caller "owns" the file in some other sense.
      expect(leadActorVerdict({ ...base, role, ownsFile: true }).ok, String(role)).toBe(false);
    }
  });
});
