/**
 * Tracker IDs 118 and 119 — source-text contract (the routes import the
 * database and cannot be loaded here), plus the pure rules they lean on.
 *
 *   ID 119: the 21 KYC actions that checked only the login / role now also
 *           check the lead is the caller's (requireLeadAccess).
 *   ID 118: uploading, starting and stopping AI-dialer calling lists is for
 *           admin, ceo and sales_head only (DIALER_CONTROL_ROLES via guardApi).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { dealerOwnsLead } from "@/lib/auth/leadAccessRules";
import { DIALER_CONTROL_ROLES, canControlDialer } from "@/lib/leads/access";

const API_DIR = join(process.cwd(), "src", "app", "api");

const code = (route: string) =>
  readFileSync(join(API_DIR, ...route.split("/"), "route.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const KYC_ACTIONS = [
  "decentro/aadhaar-otp",
  "decentro/aadhaar-verify",
  "decentro/active-video-liveness/initiate",
  "decentro/active-video-liveness/resend-sms",
  "decentro/active-video-liveness/status",
  "decentro/video-liveness",
  "decentro/bank",
  "decentro/pan",
  "decentro/face-match",
  "decentro/ocr",
  "create-payment-qr",
  "regenerate-payment-qr",
  "send-consent",
  "verify-consent-otp",
  "consent/status",
  "consent/sync",
  "consent-preview",
  "generate-consent-pdf",
  "release-coupon",
  "submit-for-verification",
  "document-status",
];

describe("ID 119 — KYC actions check whose lead it is", () => {
  it("covers the 21 actions in the tracker", () => {
    expect(KYC_ACTIONS).toHaveLength(21);
  });

  for (const action of KYC_ACTIONS) {
    it(action, () => {
      const src = code(`kyc/[leadId]/${action}`);
      expect(src).toMatch(/\brequireLeadAccess\s*\(\s*leadId\s*\)/);
      expect(src).toMatch(/if\s*\(\s*!leadGate\.ok\s*\)\s*return\s+leadGate\.response/);
    });
  }

  it("the KYC start check, borrower details and co-borrower record mask Aadhaar", () => {
    expect(code("kyc/[leadId]/access-check")).toMatch(/aadhaar_no:\s*maskAadhaar\(/);
    expect(code("kyc/[leadId]/access-check")).toMatch(/kyc_draft_data:\s*maskAadhaarDeep\(/);
    expect(code("kyc/[leadId]/borrower-details")).toMatch(/aadhaar_no:\s*maskAadhaar\(/);
    expect(code("coborrower/[leadId]")).toMatch(/aadhaar_no:\s*maskAadhaar\(/);
  });

  it("the routes the form saves back to keep the stored number", () => {
    expect(code("kyc/[leadId]/save-draft")).toMatch(/restoreMaskedAadhaarDeep\(/);
    expect(code("coborrower/[leadId]")).toMatch(/restoreMaskedAadhaar\(/);
  });
});

describe("dealerOwnsLead", () => {
  it("matches the same dealer code only", () => {
    expect(dealerOwnsLead("DLR-1", "DLR-1")).toBe(true);
    expect(dealerOwnsLead("DLR-1", "DLR-2")).toBe(false);
  });

  it("never treats two missing codes as the same dealer", () => {
    expect(dealerOwnsLead(null, null)).toBe(false);
    expect(dealerOwnsLead("", "")).toBe(false);
    expect(dealerOwnsLead("DLR-1", null)).toBe(false);
    expect(dealerOwnsLead(null, "DLR-1")).toBe(false);
  });
});

describe("ID 118 — AI-dialer lists: admin, ceo, sales_head only", () => {
  it("the role set is exactly the decision", () => {
    expect([...DIALER_CONTROL_ROLES].sort()).toEqual(["admin", "ceo", "sales_head"]);
    for (const r of ["dealer", "sales_manager", "business_head", "partner", "asm", "inside_sales_rep", "user", "", null]) {
      expect(canControlDialer(r), String(r)).toBe(false);
    }
  });

  for (const route of ["ai-dialer/lists/create", "ai-dialer/lists/[id]/start", "ai-dialer/stop", "ai-dialer/start"]) {
    it(`${route} gates on DIALER_CONTROL_ROLES before any work`, () => {
      const src = code(route);
      const handler = src.slice(src.search(/export (async function|const) POST/));
      const gateAt = handler.search(/guardApi\(\s*\[\s*\.\.\.DIALER_CONTROL_ROLES\s*\]\s*\)/);
      expect(gateAt, "guardApi([...DIALER_CONTROL_ROLES])").toBeGreaterThan(-1);
      expect(handler).toMatch(/if\s*\(\s*!gate\.ok\s*\)\s*return\s+gate\.response/);
      // the old fail-open shape: requireAuth() inside a try whose catch swallows it
      expect(handler).not.toMatch(/try\s*\{\s*(const\s+\w+\s*=\s*)?await\s+requireAuth\(\)/);
      const workAt = handler.search(/req\.(formData|json)\(|dialerSession\.|\bdb\./);
      expect(workAt === -1 || gateAt < workAt, "the gate must run first").toBe(true);
    });
  }
});
