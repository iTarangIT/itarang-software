import { describe, expect, it } from "vitest";

import { BUYBACK_ADMIN_ROLES } from "@/lib/buyback/roles";

import {
    BUYBACK_FILE_ROLES,
    NBFC_FILE_BUCKET,
    classifyFile,
    dealerUploadedFile,
    isLoggedFile,
    loggedLeadId,
    mayOpenFile,
    type FileViewer,
} from "../fileRules";

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
        expect(classifyFile("dealer-documents", "buyback/1/a.jpg")).toEqual({ kind: "buyback", requestId: null });
    });

    it("gives the formerly open folders an owner (16 Oct) and keeps unknown folders closed", () => {
        expect(classifyFile("documents", "auction/batteries/B-1/a.jpg")).toEqual({ kind: "auction_battery", batteryId: "B-1" });
        expect(classifyFile("documents", "refurb/lots/L-1/a.jpg")).toEqual({ kind: "refurb_lot", lotId: "L-1" });
        expect(classifyFile("documents", "recovery/A-1/visit-1-0.jpg")).toEqual({ kind: "recovery_visit", assignmentId: "A-1" });
        expect(classifyFile("documents", "quotations/Q-1.pdf")).toEqual({ kind: "dealer_lead_attachment", source: "quotation" });
        expect(classifyFile("documents", "feature-requests/2026/10/x.png").kind).toBe("feature_request");
        expect(classifyFile("dealer-documents", "commercials/1-x.pdf")).toEqual({ kind: "dealer_lead_attachment", source: "commercials" });
        expect(classifyFile("dealer-documents", "visit-photos/1-x.jpg")).toEqual({ kind: "dealer_lead_attachment", source: "visit" });
        expect(classifyFile("dealer-documents", `buyback/${APP}/evidence/a.pdf`)).toEqual({ kind: "buyback", requestId: APP });
        // a folder shape the uploaders do not write: top roles only
        expect(classifyFile("documents", "auction/settlements/1.pdf").kind).toBe("unknown");
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

    it("opens KYC for the lead's assignee and sales manager, like the KYC screens (ID 119)", () => {
        expect(mayOpenFile(viewer("sales_manager"), kyc, { leadSmAssignedTo: "u-1" })).toBe(true);
        expect(mayOpenFile(viewer("sales_executive"), kyc, { leadAssignedTo: "u-1" })).toBe(true);
        expect(mayOpenFile(viewer("sales_manager"), kyc, { leadSmAssignedTo: "u-2", leadAssignedTo: null })).toBe(false);
    });

    it("gives a dealer only its own customers, and the uploader its upload", () => {
        expect(mayOpenFile(viewer("dealer", { dealerCode: "D1" }), kyc, { leadDealerId: "D1" })).toBe(true);
        expect(mayOpenFile(viewer("dealer", { dealerCode: "D1" }), kyc, { leadDealerId: "D2" })).toBe(false);
        expect(mayOpenFile(viewer("dealer"), kyc, { leadDealerId: "" })).toBe(false);
        expect(mayOpenFile(viewer("dealer"), kyc, { leadDealerId: "D2", leadUploaderId: "u-1" })).toBe(true);
    });

    it("on its own customer, gives a dealer only the files it uploaded itself (ID 166, E-349)", () => {
        const dealer = viewer("dealer", { dealerCode: "D1" });
        const own = { leadDealerId: "D1" };
        const up = (uploaderId: string | null, uploaderDealerCode: string | null, source: string | null) => ({
            uploaderId,
            uploaderDealerCode,
            source,
        });
        // its own login, or another login of the same dealership
        expect(mayOpenFile(dealer, kyc, { ...own, fileUploads: [up("u-1", null, "portal")] })).toBe(true);
        expect(mayOpenFile(dealer, kyc, { ...own, fileUploads: [up("u-7", "D1", "whatsapp")] })).toBe(true);
        // Admin, the NBFC or another dealer uploaded it; the customer sent it by link
        expect(mayOpenFile(dealer, kyc, { ...own, fileUploads: [up("admin-1", null, "portal")] })).toBe(false);
        expect(mayOpenFile(dealer, kyc, { ...own, fileUploads: [up("u-9", "D2", "portal")] })).toBe(false);
        expect(mayOpenFile(dealer, kyc, { ...own, fileUploads: [up(null, null, "public_link")] })).toBe(false);
        // rows from before E-349, or no row for the file: the old rule
        expect(mayOpenFile(dealer, kyc, { ...own, fileUploads: [up(null, null, null)] })).toBe(true);
        expect(mayOpenFile(dealer, kyc, { ...own, fileUploads: [] })).toBe(true);
        // never on another dealer's customer, whoever uploaded
        expect(mayOpenFile(dealer, kyc, { leadDealerId: "D2", fileUploads: [up("u-1", "D1", "portal")] })).toBe(false);
        // the upload rule is for dealers only
        expect(mayOpenFile(viewer("admin"), kyc, { fileUploads: [up(null, null, "public_link")] })).toBe(true);
    });

    it("dealerUploadedFile: a lookup failure refuses", () => {
        const dealer = viewer("dealer", { dealerCode: "D1" });
        expect(dealerUploadedFile(dealer, [{ uploaderId: null, uploaderDealerCode: null, source: "unknown" }])).toBe(false);
        expect(dealerUploadedFile(dealer, undefined)).toBe(true);
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


const TENANT = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe("classifyFile — the NBFC store (16 Oct)", () => {
    const nbfc = (key: string) => classifyFile(NBFC_FILE_BUCKET, key);

    it("reads lead, case, tenant and partner keys", () => {
        expect(nbfc("agreements/LEAD-1/signed.pdf")).toEqual({ kind: "nbfc_lead", leadId: "LEAD-1", dealerMay: true });
        expect(nbfc("admin-attachments/LEAD-1/1-a.pdf")).toEqual({ kind: "nbfc_lead", leadId: "LEAD-1", dealerMay: false });
        expect(nbfc("verdict-attachments/LEAD-1/1-a.pdf")).toEqual({ kind: "nbfc_lead", leadId: "LEAD-1", dealerMay: false });
        expect(nbfc("fi/F-1/exterior-1-0.jpg")).toEqual({ kind: "nbfc_case", table: "fi", id: "F-1" });
        expect(nbfc("vkyc/V-1/liveness-1.webm")).toEqual({ kind: "nbfc_case", table: "vkyc", id: "V-1" });
        expect(nbfc("emi-receipts/S-1/E-1/1.jpg")).toEqual({ kind: "nbfc_case", table: "emi", id: "S-1" });
        expect(nbfc("fi-agents/0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d/1.jpg")).toEqual({
            kind: "nbfc_tenant",
            tenantRef: "0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d",
        });
        expect(nbfc(`${TENANT}/consent-template/1.pdf`)).toEqual({ kind: "nbfc_tenant", tenantRef: TENANT });
        expect(nbfc("12/signer-identity/1-a.jpg")).toEqual({ kind: "nbfc_partner_doc", nbfcId: 12, personal: true });
        expect(nbfc("12/lsp-agreement/signed.pdf")).toEqual({ kind: "nbfc_partner_doc", nbfcId: 12, personal: false });
        expect(nbfc("12/1700000000-rbi-licence.pdf")).toEqual({ kind: "nbfc_partner_doc", nbfcId: 12, personal: false });
        expect(nbfc("loose.pdf").kind).toBe("unknown");
        expect(nbfc("whatever/x/y.pdf").kind).toBe("unknown");
    });

    it("logs the identity files only", () => {
        expect(isLoggedFile(nbfc("fi/F-1/a.jpg"))).toBe(true);
        expect(isLoggedFile(nbfc("vkyc/V-1/a.webm"))).toBe(true);
        expect(isLoggedFile(nbfc("12/signer-identity/a.jpg"))).toBe(true);
        expect(isLoggedFile(nbfc("agreements/LEAD-1/signed.pdf"))).toBe(true);
        expect(isLoggedFile(nbfc("emi-receipts/S-1/E-1/1.jpg"))).toBe(false);
        expect(isLoggedFile(nbfc("12/lsp-agreement/signed.pdf"))).toBe(false);
        expect(isLoggedFile(classifyFile("dealer-documents", "gst-certificate/1.pdf"))).toBe(true);
        expect(isLoggedFile(classifyFile("documents", "expenses/u/1.jpg"))).toBe(false);
        expect(loggedLeadId(nbfc("agreements/LEAD-9/signed.pdf"))).toBe("LEAD-9");
        expect(loggedLeadId(nbfc("fi/F-1/a.jpg"))).toBeNull();
    });
});

describe("mayOpenFile — the NBFC store (16 Oct)", () => {
    const nbfc = (key: string) => classifyFile(NBFC_FILE_BUCKET, key);
    const partner = (tenants: string[], extra: Partial<FileViewer> = {}) =>
        viewer("nbfc_partner", { nbfcTenantIds: tenants, ...extra });

    it("opens a field visit / video KYC only for the NBFC that owns the case, the top roles and the account owner", () => {
        const fi = nbfc("fi/F-1/a.jpg");
        expect(mayOpenFile(partner(["T1"]), fi, { ownerTenantIds: ["T1"] })).toBe(true);
        expect(mayOpenFile(partner(["T2"]), fi, { ownerTenantIds: ["T1"] })).toBe(false);
        expect(mayOpenFile(viewer("dealer", { dealerCode: "D1" }), fi, { ownerTenantIds: ["T1"] })).toBe(false);
        expect(mayOpenFile(viewer("sales_manager"), fi, { ownerTenantIds: ["T1"] })).toBe(false);
        expect(mayOpenFile(viewer("asm"), fi, { ownerTenantIds: ["T1"], accountOwnerId: "u-1" })).toBe(true);
        for (const role of ["admin", "ceo", "sales_head"]) expect(mayOpenFile(viewer(role), fi)).toBe(true);
        // a missing fact is a refusal
        expect(mayOpenFile(partner(["T1"]), fi)).toBe(false);
    });

    it("opens per-lead files for the NBFCs the application is shared with; the agreement also for the dealer of the lead", () => {
        const agreement = nbfc("agreements/LEAD-1/signed.pdf");
        const attachment = nbfc("admin-attachments/LEAD-1/a.pdf");
        expect(mayOpenFile(partner(["T1"]), attachment, { sharedTenantIds: ["T1"] })).toBe(true);
        expect(mayOpenFile(partner(["T3"]), attachment, { sharedTenantIds: ["T1"] })).toBe(false);
        const dealer = viewer("dealer", { dealerCode: "D1" });
        expect(mayOpenFile(dealer, agreement, { leadDealerId: "D1" })).toBe(true);
        expect(mayOpenFile(dealer, agreement, { leadDealerId: "D2" })).toBe(false);
        expect(mayOpenFile(dealer, attachment, { leadDealerId: "D1" })).toBe(false);
    });

    it("matches tenant-wide files by the tenant id, dashes or not", () => {
        const agentPhoto = nbfc("fi-agents/0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d/1.jpg");
        expect(mayOpenFile(partner([TENANT]), agentPhoto)).toBe(true);
        expect(mayOpenFile(partner(["11111111-2222-4333-8444-555555555555"]), agentPhoto)).toBe(false);
        expect(mayOpenFile(partner([TENANT]), nbfc(`${TENANT}/consent-template/1.pdf`))).toBe(true);
        expect(mayOpenFile(viewer("business_head"), agentPhoto)).toBe(false);
    });

    it("opens the onboarding papers of an NBFC for that NBFC and the top roles only", () => {
        const signer = nbfc("12/signer-identity/a.jpg");
        expect(mayOpenFile(partner(["T1"]), signer, { ownerTenantIds: ["T1"] })).toBe(true);
        expect(mayOpenFile(partner(["T2"]), signer, { ownerTenantIds: ["T1"] })).toBe(false);
        expect(mayOpenFile(viewer("business_head"), signer, { ownerTenantIds: ["T1"] })).toBe(false);
        expect(mayOpenFile(viewer("admin"), signer)).toBe(true);
    });
});

describe("mayOpenFile — folders that were open to any login (16 Oct)", () => {
    it("quotations, commercials and visit photos: the owner / ASM of the dealer lead and the top roles", () => {
        for (const key of ["commercials/1-q.pdf", "visit-photos/1-a.jpg"]) {
            const f = classifyFile("dealer-documents", key);
            expect(mayOpenFile(viewer("asm"), f, { dealerLeadOwnerIds: ["u-1"] })).toBe(true);
            expect(mayOpenFile(viewer("asm"), f, { dealerLeadOwnerIds: ["u-2", null] })).toBe(false);
            expect(mayOpenFile(viewer("dealer", { dealerCode: "D1" }), f)).toBe(false);
            expect(mayOpenFile(viewer("sales_head"), f)).toBe(true);
        }
        const quote = classifyFile("documents", "quotations/Q-1.pdf");
        expect(mayOpenFile(viewer("inside_sales_rep"), quote, { dealerLeadOwnerIds: ["u-1"] })).toBe(true);
        expect(mayOpenFile(viewer("inside_sales_rep"), quote)).toBe(false);
    });

    it("buyback: buyback staff and the dealer that raised the request", () => {
        const f = classifyFile("dealer-documents", `buyback/${APP}/evidence/a.pdf`);
        for (const role of BUYBACK_FILE_ROLES) expect(mayOpenFile(viewer(role), f)).toBe(true);
        expect(mayOpenFile(viewer("dealer", { dealerCode: "ACC-1" }), f, { buybackDealerId: "ACC-1" })).toBe(true);
        expect(mayOpenFile(viewer("dealer", { dealerCode: "ACC-2" }), f, { buybackDealerId: "ACC-1" })).toBe(false);
        expect(mayOpenFile(viewer("inside_sales_rep"), f, { buybackDealerId: "ACC-1" })).toBe(false);
        // statements / vendor staging carry no request: buyback staff only
        const statement = classifyFile("dealer-documents", "buyback/statements/1.xlsx");
        expect(mayOpenFile(viewer("dealer", { dealerCode: "ACC-1" }), statement)).toBe(false);
    });

    it("the buyback staff list matches the one in the buyback module", () => {
        expect([...BUYBACK_FILE_ROLES]).toEqual([...BUYBACK_ADMIN_ROLES]);
    });

    it("feature requests: seat holders", () => {
        const f = classifyFile("documents", "feature-requests/2026/10/a.png");
        expect(mayOpenFile(viewer("inside_sales_rep"), f, { hasFeatureSeat: true })).toBe(true);
        expect(mayOpenFile(viewer("inside_sales_rep"), f, { hasFeatureSeat: false })).toBe(false);
    });

    it("auction battery photos: the owning NBFC, and a dealer in the audience of a lot", () => {
        const f = classifyFile("documents", "auction/batteries/B-1/front.jpg");
        expect(mayOpenFile(viewer("nbfc_partner", { nbfcTenantIds: ["T1"] }), f, { ownerTenantIds: ["T1"] })).toBe(true);
        expect(mayOpenFile(viewer("nbfc_partner", { nbfcTenantIds: ["T2"] }), f, { ownerTenantIds: ["T1"] })).toBe(false);
        expect(mayOpenFile(viewer("dealer", { dealerCode: "D1" }), f, { audienceDealerIds: ["D1"] })).toBe(true);
        expect(mayOpenFile(viewer("dealer", { dealerCode: "D1" }), f, { audienceDealerIds: [] })).toBe(false);
    });

    it("refurbishment lots: the owning NBFC and the refurbisher on the lot", () => {
        const f = classifyFile("documents", "refurb/lots/L-1/a.jpg");
        expect(mayOpenFile(viewer("refurbisher", { refurbisherId: "R1" }), f, { refurbisherId: "R1" })).toBe(true);
        expect(mayOpenFile(viewer("refurbisher", { refurbisherId: "R2" }), f, { refurbisherId: "R1" })).toBe(false);
        expect(mayOpenFile(viewer("refurbisher"), f, { refurbisherId: null })).toBe(false);
        expect(mayOpenFile(viewer("nbfc_partner", { nbfcTenantIds: ["T1"] }), f, { ownerTenantIds: ["T1"] })).toBe(true);
    });

    it("recovery visit photos: the owning NBFC and the top roles", () => {
        const f = classifyFile("documents", "recovery/A-1/visit-1-0.jpg");
        expect(mayOpenFile(viewer("nbfc_partner", { nbfcTenantIds: ["T1"] }), f, { ownerTenantIds: ["T1"] })).toBe(true);
        expect(mayOpenFile(viewer("dealer", { dealerCode: "D1" }), f, { ownerTenantIds: ["T1"] })).toBe(false);
        expect(mayOpenFile(viewer("ceo"), f)).toBe(true);
    });
});
