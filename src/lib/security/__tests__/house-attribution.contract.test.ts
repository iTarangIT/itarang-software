/**
 * ID 183 (21 Oct) — the house login works pushed files in the dealer portal
 * like the dealer, but what it does is NOT recorded as if the dealer did it:
 *
 *  - the dispatch steps (Step 5 stock pick, dispatch code send / check,
 *    confirm dispatch), the cash sale, "delivered" and the customer-details
 *    edit go through gateLeadActor (the dealer stamps + clears the note; the
 *    house takes its own note and is held to "dealer acted after you opened")
 *    and then recordActorStep ("Done by" + dealer notice) — never the bare
 *    stampDealerAction, which wiped another person's "being worked by" note;
 *  - the smaller saves (KYC draft, finishing KYC steps 2 / 3, co-borrower
 *    details + draft, the printable consent form, releasing a coupon, the
 *    product photo) call recordActorStep too, the autosaves coalesced;
 *  - the printable consent form (and its preview) names the FILE's dealer
 *    when someone else makes it.
 *
 * Source-text contract like lead-writer.contract.test.ts: the routes import
 * the database and cannot be loaded here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const API = join(process.cwd(), "src", "app", "api");
const code = (rel: string) =>
  readFileSync(join(API, ...rel.split("/"), "route.ts"), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const DISPATCH = [
  "lead/[id]/step-5/product-selection",
  "lead/[id]/step-5/send-otp",
  "lead/[id]/step-5/verify-otp",
  "lead/[id]/step-5/confirm-dispatch",
  "lead/[id]/confirm-cash-sale",
  "lead/[id]/mark-delivered",
];

const SMALL_SAVES: Array<[string, RegExp]> = [
  ["kyc/[leadId]/save-draft", /recordActorStep\([^;]*coalesce:\s*true/],
  ["kyc/[leadId]/complete-step2", /recordActorStep\(/],
  ["kyc/[leadId]/complete-step3", /recordActorStep\(/],
  ["coborrower/[leadId]", /recordActorStep\([^;]*coalesce:\s*true/],
  ["coborrower/[leadId]/save-draft", /recordActorStep\([^;]*coalesce:\s*true/],
  ["kyc/[leadId]/generate-consent-pdf", /recordActorStep\(/],
  ["kyc/[leadId]/release-coupon", /recordActorStep\(/],
  ["lead/[id]/product-photo", /recordActorStep\(/],
];

describe("ID 183: the house login's dispatch steps and customer edits are recorded as the house", () => {
  for (const rel of [...DISPATCH, "dealer/leads/[id]"]) {
    it(`${rel} gates the actor and records "Done by"`, () => {
      const src = code(rel);
      expect(src).not.toMatch(/\bstampDealerAction\s*\(/);
      expect(src).toMatch(/\bgateLeadActor\s*\(\s*user\s*,[^;]*write:\s*true[^;]*seenDealerActionAt:\s*seenFromRequest\(/);
      expect(src).toMatch(/\brecordActorStep\s*\(/);
    });
  }
  it("the dispatch steps still require the file's dealer or the house (dealerMayDispatch)", () => {
    for (const rel of DISPATCH) expect(code(rel), rel).toMatch(/\bdealerMayDispatch\s*\(/);
  });
});

describe("ID 183: the smaller saves write the Done-by line and the notice", () => {
  for (const [rel, re] of SMALL_SAVES) {
    it(rel, () => expect(code(rel)).toMatch(re));
  }
});

describe("ID 183: the printable consent form names the file's dealer", () => {
  it("generate-consent-pdf uses the file's dealer for anyone but that dealer", () => {
    const src = code("kyc/[leadId]/generate-consent-pdf");
    expect(src).toMatch(/isItarangActor\(writer\.actor\.kind\)[\s\S]*fileDealerNames\(writer\.lead\.dealer_id\)/);
  });
  it("consent-preview does the same", () => {
    expect(code("kyc/[leadId]/consent-preview")).toMatch(/!ownDealer[\s\S]*fileDealerNames\(/);
  });
});

// 23 Oct: the older routes (unlinked loan-options page, send for review, clear
// draft) let the house login change a pushed file with no dealer-wins check
// and no "Done by". They now go through the shared writer gate and record.
describe("ID 183 (23 Oct): the older loan-option, review and draft routes gate and record", () => {
  for (const rel of [
    "leads/[id]/loan-offers/[offerId]/select",
    "leads/[id]/loan-offers/[offerId]/book",
    "leads/[id]/submit-to-sm",
    "dealer/leads/drafts/[leadId]",
  ]) {
    it(rel, () => {
      const src = code(rel);
      expect(src).not.toMatch(/\bdealerMayActOnLead\s*\(/);
      expect(src).toMatch(/\brequireLeadWriter\s*\(\s*leadId\s*,\s*req\s*,/);
      expect(src).toMatch(/\brecordActorStep\s*\(/);
    });
  }
  it("the Step 3 screen sends the dealer-wins header (LeadWorkNote)", () => {
    const page = readFileSync(
      join(process.cwd(), "src", "app", "(dashboard)", "dealer-portal", "leads", "[id]", "borrower-consent", "page.tsx"),
      "utf8",
    );
    expect(page).toMatch(/<LeadWorkNote leadId=\{leadId\} \/>/);
  });
});
