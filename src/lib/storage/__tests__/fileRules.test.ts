import { describe, expect, it } from "vitest";

import { classifyFile, mayOpenFile, type FileViewer } from "../fileRules";

const APP = "3f1c2a7e-1b2c-4d5e-8f90-123456789abc";

const viewer = (role: string, extra: Partial<FileViewer> = {}): FileViewer => ({
    id: "u-1",
    role,
    dealerCode: null,
    nbfcTenantIds: [],
    ...extra,
});

describe("classifyFile (ID 166)", () => {
    it("reads the lead id out of customer KYC keys", () => {
        expect(classifyFile("documents", "kyc/LEAD-20260901-ab12cd34/aadhaar_front_1.jpg")).toEqual({
            kind: "customer_lead",
            leadId: "LEAD-20260901-ab12cd34",
            kyc: true,
        });
        expect(classifyFile("documents", "leads/LEAD-1/pre-sanction-docs/a.pdf").kind).toBe("customer_lead");
    });

    it("splits bills, invoice scans, accounts and assistant media", () => {
        expect(classifyFile("documents", "expenses/u-9/1.jpg")).toEqual({ kind: "expense_bill", submitterId: "u-9" });
        expect(classifyFile("documents", "sales/drive/f1/inv.pdf").kind).toBe("sales_invoice_scan");
        expect(classifyFile("documents", "accounts/ACC-1/gst.pdf")).toEqual({ kind: "account", accountId: "ACC-1" });
        expect(classifyFile("documents", "wa-assistant/u-2/2026-10/x.jpg")).toEqual({ kind: "assistant_media", userId: "u-2" });
    });

    it("knows call recordings", () => {
        expect(classifyFile("call-recordings", "attached/DL-7/rec1.mp3")).toEqual({ kind: "dealer_lead", dealerLeadId: "DL-7" });
        expect(classifyFile("call-recordings", "bolna/call-1.mp3").kind).toBe("provider_recording");
        expect(classifyFile("call-recordings", "prod/elevenlabs/conv-1.mp3").kind).toBe("provider_recording");
    });

    it("tells agreements from onboarding uploads", () => {
        expect(classifyFile("dealer-documents", `agreements/${APP}/signed-agreement.pdf`)).toEqual({
            kind: "dealer_agreement",
            applicationId: APP,
        });
        expect(classifyFile("dealer-documents", `${APP}/audit-trail.pdf`)).toEqual({ kind: "dealer_agreement", applicationId: APP });
        expect(classifyFile("dealer-documents", "gst-certificate/1-x-gst.pdf").kind).toBe("dealer_onboarding");
        expect(classifyFile("dealer-documents", "agreement-template-file/t.docx").kind).toBe("agreement_template");
        expect(classifyFile("dealer-documents", "buyback/1/a.jpg").kind).toBe("operational");
    });

    it("keeps operational photos open and unknown folders closed", () => {
        expect(classifyFile("documents", "auction/batteries/1/a.jpg").kind).toBe("operational");
        expect(classifyFile("documents", "something-new/a.pdf").kind).toBe("unknown");
    });
});

describe("mayOpenFile (ID 166)", () => {
    const kyc = classifyFile("documents", "kyc/LEAD-1/pan.jpg");

    it("opens customer KYC for Admin, Sales Head and CEO", () => {
        for (const role of ["admin", "sales_head", "ceo"]) expect(mayOpenFile(viewer(role), kyc)).toBe(true);
    });

    it("refuses KYC to staff who do not own the account (decision 9)", () => {
        for (const role of ["business_head", "sales_manager", "sales_executive", "finance_controller", "inside_sales_rep", "asm"]) {
            expect(mayOpenFile(viewer(role), kyc, { accountOwnerId: "someone-else" })).toBe(false);
        }
        expect(mayOpenFile(viewer("asm"), kyc, { accountOwnerId: "u-1" })).toBe(true);
    });

    it("gives a dealer only its own customers, and the uploader its upload", () => {
        expect(mayOpenFile(viewer("dealer", { dealerCode: "D1" }), kyc, { leadDealerId: "D1" })).toBe(true);
        expect(mayOpenFile(viewer("dealer", { dealerCode: "D1" }), kyc, { leadDealerId: "D2" })).toBe(false);
        expect(mayOpenFile(viewer("dealer"), kyc, { leadDealerId: "" })).toBe(false);
        expect(mayOpenFile(viewer("dealer"), kyc, { leadDealerId: "D2", leadUploaderId: "u-1" })).toBe(true);
    });

    it("gives an NBFC only applications shared with it", () => {
        const nbfc = viewer("nbfc_partner", { nbfcTenantIds: ["T1"] });
        expect(mayOpenFile(nbfc, kyc, { sharedTenantIds: ["T1"] })).toBe(true);
        expect(mayOpenFile(nbfc, kyc, { sharedTenantIds: ["T2"] })).toBe(false);
        expect(mayOpenFile(nbfc, kyc)).toBe(false);
    });

    it("keeps bills and invoice scans away from the Sales Head", () => {
        const bill = classifyFile("documents", "expenses/u-9/1.jpg");
        expect(mayOpenFile(viewer("sales_head"), bill)).toBe(false);
        expect(mayOpenFile(viewer("finance_controller"), bill)).toBe(true);
        expect(mayOpenFile(viewer("asm", { id: "u-9" }), bill)).toBe(true);
        expect(mayOpenFile(viewer("sales_head"), classifyFile("documents", "sales/drive/1/a.pdf"))).toBe(false);
    });

    it("opens recordings for the lead's owner or ASM only", () => {
        const rec = classifyFile("call-recordings", "attached/DL-7/r.mp3");
        expect(mayOpenFile(viewer("inside_sales_rep"), rec, { dealerLeadOwnerIds: ["u-1", null] })).toBe(true);
        expect(mayOpenFile(viewer("inside_sales_rep"), rec, { dealerLeadOwnerIds: ["u-2", "u-3"] })).toBe(false);
        expect(mayOpenFile(viewer("inside_sales_rep"), rec)).toBe(false);
    });

    it("opens an onboarding file for its dealer and the account owner", () => {
        const doc = classifyFile("dealer-documents", "gst-certificate/1.pdf");
        expect(mayOpenFile(viewer("dealer"), doc, { applicationDealerUserId: "u-1" })).toBe(true);
        expect(mayOpenFile(viewer("dealer"), doc, { applicationDealerUserId: "u-2" })).toBe(false);
        expect(mayOpenFile(viewer("sales_manager"), doc, { accountOwnerId: "u-1" })).toBe(true);
    });

    it("never opens an unknown folder below the top roles", () => {
        const unknown = classifyFile("documents", "new-folder/a.pdf");
        expect(mayOpenFile(viewer("admin"), unknown)).toBe(true);
        expect(mayOpenFile(viewer("business_head"), unknown)).toBe(false);
    });
});
