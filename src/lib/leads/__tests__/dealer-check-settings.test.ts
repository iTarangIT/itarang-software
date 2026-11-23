import { beforeAll, describe, expect, it } from "vitest";

import { decisionPhrase, normalizeDealerCheckSettings, PAPERWORK_ACCEPTED_NOTE, validateRecipients } from "../dealer-check-settings-rules";
import { mintDealerCheckToken, readDealerCheckToken } from "../dealer-check-token";

const R = "11111111-2222-4333-8444-555555555555";
const U = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

beforeAll(() => {
  process.env.DEALER_CHECK_TOKEN_SECRET = "test-secret";
});

describe("dealer-check link", () => {
  it("round-trips the check and the recipient", () => {
    expect(readDealerCheckToken(mintDealerCheckToken(R, U))).toEqual({ reviewId: R, userId: U });
  });

  it("refuses a tampered or foreign token", () => {
    const t = mintDealerCheckToken(R, U);
    const other = Buffer.from(`dc1:${R}:${R}`).toString("base64url");
    expect(readDealerCheckToken(`${other}.${t.split(".")[1]}`)).toBeNull();
    expect(readDealerCheckToken(t.slice(0, -1) + (t.endsWith("a") ? "b" : "a"))).toBeNull();
    expect(readDealerCheckToken("nonsense")).toBeNull();
    expect(readDealerCheckToken(null)).toBeNull();
  });
});

describe("dealer-check settings", () => {
  it("cleans recipients: valid uuid, dedupe, mobile + email normalised, channel off without contact", () => {
    const s = normalizeDealerCheckSettings({
      houseApproverIds: [U, U, "bad"],
      recipients: [
        { userId: U, name: " Chirag ", email: "Chirag@Itarang.com", whatsapp: "+91 98765-43210" },
        { userId: U, name: "dup" },
        { userId: R, name: "Sanchit", email: "not-an-email", whatsapp: "123" },
        { userId: "x", name: "bad id" },
      ],
    });
    expect(s.houseApproverIds).toEqual([U]);
    expect(s.recipients).toHaveLength(2);
    expect(s.recipients[0]).toMatchObject({ name: "Chirag", email: "chirag@itarang.com", whatsapp: "9876543210", emailOn: true, whatsappOn: true });
    expect(s.recipients[1]).toMatchObject({ email: null, whatsapp: null, emailOn: false, whatsappOn: false });
    expect(validateRecipients(s.recipients)).toHaveLength(1);
  });

  it("words the decision and the paperwork note", () => {
    expect(decisionPhrase("change", "A Motors", "B Motors")).toBe("changed the dealer from A Motors to B Motors");
    expect(PAPERWORK_ACCEPTED_NOTE).toMatch(/does not mean the KYC is approved/);
  });
});
