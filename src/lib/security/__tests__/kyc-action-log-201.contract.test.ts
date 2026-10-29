/**
 * ID 201 (Kartik, 27 Oct) — RELEASE-BLOCKING: every KYC action is logged.
 *
 * The log writers are called from many places; nothing else notices when one
 * is lost in an edit. So this checks, by reading the source:
 *   - each Admin / Sales Head check, override and consent decision logs;
 *   - each WhatsApp KYC step logs with channel WhatsApp;
 *   - the owning dealer's own steps become plain history lines;
 *   - the history route redacts staff names for the owning dealer.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const API = join(process.cwd(), "src", "app", "api");
const LIB = join(process.cwd(), "src", "lib");
const route = (rel: string) => readFileSync(join(API, rel, "route.ts"), "utf8");
const lib = (rel: string) => readFileSync(join(LIB, rel), "utf8");

const ADMIN_CHECKS = [
    "pan/verify",
    "bank/verify",
    "cibil/score",
    "cibil/report",
    "rc/verify",
    "aadhaar/digilocker/initiate",
    "aadhaar/digilocker/resend-sms",
    "aadhaar/digilocker/status/[transactionId]",
    "ocr",
    "audit",
    "coborrower/pan/verify",
    "coborrower/bank/verify",
    "coborrower/cibil/score",
    "coborrower/cibil/report",
    "coborrower/rc/verify",
    "coborrower/aadhaar/digilocker/initiate",
    "coborrower/aadhaar/digilocker/resend-sms",
    "coborrower/aadhaar/digilocker/status/[transactionId]",
];

describe("ID 201 #2: Admin / Sales Head checks, overrides and consent decisions are logged", () => {
    for (const rel of ADMIN_CHECKS) {
        it(rel, () => expect(route(`admin/kyc/[leadId]/${rel}`)).toMatch(/\brecordStaffKycStep\s*\(/));
    }
    it("the polled DigiLocker status logs once per request and outcome", () => {
        expect(route("admin/kyc/[leadId]/aadhaar/digilocker/status/[transactionId]")).toMatch(/once:\s*`digilocker:/);
    });
    it("consent approve and reject", () => {
        const src = route("kyc/[leadId]/consent/admin");
        expect(src.match(/\brecordStaffKycStep\s*\(/g)?.length).toBe(2);
    });
});

describe("ID 201 #3: every WhatsApp KYC step is logged", () => {
    const counts: Array<[string, number]> = [
        ["whatsapp/orchestrator.ts", 9],
        ["whatsapp/coborrower-flow.ts", 9],
        ["whatsapp/doc-request-flow.ts", 1],
        ["whatsapp/extra-docs-flow.ts", 1],
    ];
    for (const [rel, n] of counts) {
        it(`${rel} (${n} steps)`, () => {
            expect(lib(rel).match(/\brecordWhatsAppKycStep\s*\(/g)?.length ?? 0).toBeGreaterThanOrEqual(n);
        });
    }
    it("the WhatsApp writer stamps channel whatsapp on every actor", () => {
        const src = lib("kyc/kycWhatsAppLog.ts");
        const returns = src.match(/return \{[^}]*\}/g) ?? [];
        expect(returns.length).toBeGreaterThanOrEqual(4);
        for (const r of returns) expect(r).toMatch(/channel:\s*"whatsapp"/);
    });
});

describe("ID 201 #4: the owning dealer's own steps are history lines", () => {
    it("recordActorStep writes a KYC line for the dealer instead of returning early", () => {
        const src = lib("leads/actForDealerGuard.ts");
        const body = src.slice(src.indexOf("export async function recordActorStep("));
        expect(body.slice(0, body.indexOf("let anyRecent"))).toMatch(/actor\.kind === "dealer"[\s\S]*recordKycEvent\(/);
    });
    it("the KYC wrappers stop it writing the same step twice", () => {
        const src = lib("kyc/kycEventLog.ts");
        expect(src.match(/opts = \{ \.\.\.opts, kycLine: true \};/g)?.length).toBe(2);
    });
    it("Step 1 saved by the dealer is logged", () => {
        expect(route("leads/create")).toMatch(/Saved the customer details \(Step 1\)/);
    });
});

describe("ID 201 #6: the owning dealer never sees staff names", () => {
    it("the history route redacts for the owning dealer", () => {
        expect(route("kyc/[leadId]/timeline")).toMatch(/kycRowsForViewer\(\s*rows\s*,\s*viewer\s*\)/);
    });
    it("the help card and WhatsApp History use the dealer-facing lines", () => {
        expect(route("lead/[id]/assist-request")).toMatch(/dealerFacingHistory\(/);
        expect(lib("whatsapp/history-flow.ts")).toMatch(/dealerFacingHistory\(/);
    });
    it("the assist notice to the dealer names the iTarang team", () => {
        expect(lib("leads/actForDealerGuard.ts")).toMatch(/notifyDealerOfAssist\(actor\.leadId, dealerFacingDoneByLine\(/);
    });
    it("the KYC WhatsApp line to the dealer names the iTarang team", () => {
        expect(lib("kyc/kycEventLog.ts")).toMatch(/const forDealer = type === "system" \? actor : ITARANG_TEAM;/);
    });
});

describe("ID 201, 28 Oct gaps", () => {
    it("1: the dealer's WhatsApp steps outside KYC are logged (Step 4, offer, cash sale, dispatch)", () => {
        const counts: Array<[string, number]> = [
            ["whatsapp/step4-flow.ts", 2],
            ["whatsapp/offer-flow.ts", 1],
            ["whatsapp/dispatch-flow.ts", 2],
            ["whatsapp/cash-flow.ts", 2],
        ];
        for (const [rel, n] of counts) {
            expect(lib(rel).match(/\brecordWhatsAppKycStep\s*\(/g)?.length ?? 0, rel).toBeGreaterThanOrEqual(n);
        }
    });
    it("2: a staff line with no dealer given is for the file's dealer", () => {
        const src = lib("kyc/kycEventLog.ts");
        const body = src.slice(src.indexOf("export async function recordKycEvent("));
        expect(body.slice(0, body.indexOf("db.insert(auditLogs)"))).toMatch(
            /forDealerId === undefined[\s\S]*SELECT dealer_id FROM leads/,
        );
    });
    it("4: a product-only change is a Step 4 line", () => {
        expect(route("dealer/leads/[id]")).toMatch(/changed the product \(Step 4\)/);
    });
    it("5: an iTarang / house step outside KYC is also a KYC history line, before the Done-by coalescing", () => {
        const src = lib("leads/actForDealerGuard.ts");
        const body = src.slice(src.indexOf("export async function recordActorStep("));
        const head = body.slice(0, body.indexOf("let anyRecent"));
        expect(head).toMatch(/!opts\.kycLine && !opts\.coalesce[\s\S]*recordKycEvent\([\s\S]*actorOf\(actor\)/);
    });
});
