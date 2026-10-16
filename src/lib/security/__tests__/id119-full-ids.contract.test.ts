/**
 * Tracker ID 119 follow-ups (12 Oct), source-text contract plus the pure rule:
 *   - full PAN only for Admin, Sales Head, CEO and the lead's owner (the ID 166
 *     rule of 10 Oct); sales managers / executives get it masked;
 *   - no customer-KYC route sends the full Aadhaar to the browser;
 *   - a dealer login with no users.dealer_id is no longer refused on its own
 *     leads: the dealer lead routes resolve the dealer through the shared
 *     helper instead of comparing users.dealer_id directly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FULL_ID_ROLES, mayReadFullIds } from "@/lib/auth/leadAccessRules";

const API = join(process.cwd(), "src", "app", "api");
const code = (route: string) =>
    readFileSync(join(API, ...route.split("/"), "route.ts"), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

describe("mayReadFullIds", () => {
    it("Admin, Sales Head and CEO read every lead's full PAN", () => {
        for (const role of FULL_ID_ROLES) expect(mayReadFullIds({ role, userId: "u1" })).toBe(true);
        expect(mayReadFullIds({ role: "ADMIN", userId: "u1" })).toBe(true);
    });

    it("sales managers and executives only on a lead they own", () => {
        for (const role of ["sales_manager", "sales_executive", "business_head", "finance_controller"]) {
            expect(mayReadFullIds({ role, userId: "u1" })).toBe(false);
            expect(mayReadFullIds({ role, userId: "u1", leadUploaderId: "u2", accountOwnerId: "u3" })).toBe(false);
            expect(mayReadFullIds({ role, userId: "u1", leadUploaderId: "u1" })).toBe(true);
            expect(mayReadFullIds({ role, userId: "u1", accountOwnerId: "u1" })).toBe(true);
        }
    });

    it("a dealer only on its own lead; a missing fact is a refusal", () => {
        expect(mayReadFullIds({ role: "dealer", userId: "d1", dealerOwnsLead: true })).toBe(true);
        expect(mayReadFullIds({ role: "dealer", userId: "d1", dealerOwnsLead: false })).toBe(false);
        expect(mayReadFullIds({ role: "dealer", userId: "d1", leadUploaderId: "d1" })).toBe(false);
        expect(mayReadFullIds({ role: "sales_manager", userId: "", leadUploaderId: "" })).toBe(false);
        expect(mayReadFullIds({ role: null, userId: null })).toBe(false);
    });
});

describe("routes that hand out the PAN mask it for everyone else", () => {
    it.each([
        ["kyc/[leadId]/borrower-details", /leadGate\.user\.fullIds \? borrowerForm\.pan_no \|\| null : maskPan\(/],
        ["kyc/[leadId]/access-check", /leadGate\.user\.fullIds \? pd\?\.pan_no \?\? null : maskPan\(/],
        ["coborrower/[leadId]", /access\.user\.fullIds \? cob\[0\]\.pan_no : maskPan\(/],
        ["admin/kyc/[leadId]/case-review", /fullIdsForLead\(appUser, leadId\)/],
        ["admin/kyc/[leadId]/ocr", /access\.user\.fullIds \? maskAadhaarDeep\(result\) : maskPanDeep\(maskAadhaarDeep\(result\)\)/],
        ["admin/kyc-reviews", /maskPanDeep\(maskAadhaarDeep\(result\)\)/],
    ])("%s", (route, rule) => {
        expect(code(route)).toMatch(rule);
    });

    it("the save routes keep the stored PAN when the mask comes back", () => {
        expect(code("kyc/[leadId]/save-draft")).toMatch(/restoreMaskedPanDeep\(/);
        expect(code("coborrower/[leadId]")).toMatch(/restoreMaskedPan\(body\.pan_no/);
        expect(code("kyc/[leadId]/submit-verification")).toMatch(/isMaskedPan\(sentPan\)/);
        expect(code("kyc/[leadId]/decentro/pan")).toMatch(/isMaskedPan\(pan_number\)/);
    });
});

describe("no customer-KYC route sends the full Aadhaar", () => {
    it.each([
        ["admin/kyc/[leadId]/case-review", /maskAadhaarDeep\(payload\)/],
        ["admin/kyc/[leadId]/ocr", /maskAadhaarDeep\(result\)/],
        ["admin/kyc-reviews", /maskAadhaarDeep\(result\)/],
        ["leads/digilocker/status/[transactionId]", /maskAadhaarDeep\(txn\.aadhaar_extracted_data\)/],
        ["nbfc/acquire/[leadId]/kyc/ocr", /maskAadhaarDeep\(result\)/],
        ["nbfc/acquire/[leadId]/verify/results", /maskAadhaarDeep\(digi\[0\]/],
        ["kyc/[leadId]/borrower-details", /aadhaar_no: maskAadhaar\(/],
        ["kyc/[leadId]/access-check", /aadhaar_no: maskAadhaar\(/],
        ["coborrower/[leadId]", /aadhaar_no: maskAadhaar\(/],
    ])("%s", (route, rule) => {
        expect(code(route)).toMatch(rule);
    });

    it("the DigiLocker poll checks the lead is the dealer's own", () => {
        expect(code("leads/digilocker/status/[transactionId]")).toMatch(/dealerMayActOnLead\(user, lead\.dealer_id(, [\w.]+)?\)/);
    });
});

describe("dealer lead routes resolve the dealer, never compare users.dealer_id raw", () => {
    const ROUTES = [
        "dealer/leads/[id]",
        "dealer/leads/drafts/[leadId]",
        "lead/[id]/close-lead",
        "lead/[id]/confirm-cash-sale",
        "lead/[id]/mark-delivered",
        "lead/[id]/nbfc-requests",
        "lead/[id]/nbfc-requests/[requestId]/reply",
        "lead/[id]/offers",
        "lead/[id]/pre-sanction-doc",
        "lead/[id]/product-photo",
        "lead/[id]/product-selection/draft",
        "lead/[id]/requested-loan-amount",
        "lead/[id]/reselect-financing",
        "lead/[id]/section-g-options",
        "lead/[id]/select-winner",
        "lead/[id]/step-5/confirm-dispatch",
        "lead/[id]/step-5/product-selection",
        "lead/[id]/step-5/send-otp",
        "lead/[id]/step-5/status",
        "lead/[id]/step-5/verify-otp",
        "lead/[id]/step-5-access",
        "lead/[id]/submit-product-selection",
        "lead/[id]/switch-to-cash",
        "leads/[id]/loan-offers",
        "leads/[id]/loan-offers/[offerId]/book",
        "leads/[id]/loan-offers/[offerId]/select",
        "leads/[id]/submit-to-sm",
        "product-selections/[id]",
    ];
    // 14 Oct added the leadId (house access); 16 Oct (ID 183) routes the lender
    // journey through gateLeadActor (dealer / house / Admin acting for the
    // dealer) and the dispatch steps through dealerMayDispatch (owner only).
    const RESOLVED = /dealerMayActOnLead\(user, lead\.dealer_id(, [\w.]+)?\)|dealerMayDispatch\(user, lead\.dealer_id(, leadId)?\)|gateLeadActor\(user, lead\b/;
    it.each(ROUTES)("%s", (route) => {
        const src = code(route);
        expect(src).toMatch(RESOLVED);
        expect(src).not.toMatch(/lead\.dealer_id\s*[!=]==?\s*user\.dealer_id/);
    });
});

// 16 Oct evening (user): the iTarang house login on a file it pushed out may
// dispatch too (dealerMayDispatch with the lead id → houseMayActOnLead). What
// stays pinned: no Admin / Sales Head acting for the dealer on these steps.
describe("ID 183: dispatch is the file's dealer's (or the house's), never iTarang staff", () => {
    it.each([
        "lead/[id]/step-5/confirm-dispatch",
        "lead/[id]/step-5/product-selection",
        "lead/[id]/step-5/send-otp",
        "lead/[id]/step-5/status",
        "lead/[id]/step-5/verify-otp",
        "lead/[id]/step-5-access",
        "lead/[id]/confirm-cash-sale",
        "lead/[id]/mark-delivered",
    ])("%s is the dealer's or the house's (no iTarang staff)", (route) => {
        const src = code(route);
        expect(src).toMatch(/dealerMayDispatch\(user, lead\.dealer_id, leadId\)/);
        expect(src).not.toMatch(/dealerMayActOnLead|gateLeadActor/);
    });
});
