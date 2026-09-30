import { describe, expect, it } from "vitest";
import {
    checkExecutedAgreement,
    nameOverlap,
    toIsoDay,
    type ExtractedAgreementDoc,
} from "@/lib/agreement/executedAgreementCheck";

const doc = (o: Partial<ExtractedAgreementDoc> = {}): ExtractedAgreementDoc => ({
    kind: "signed_agreement",
    ok: true,
    documentId: "DID2609A",
    dealerName: "Sharma Battery House Pvt Ltd",
    gstin: "27ABCDE1234F1Z5",
    agreementDate: "2026-09-10",
    referenceNumber: null,
    signers: [
        { name: "Ravi Sharma", signedAt: "2026-09-11T10:00:00+05:30" },
        { name: "iTarang signatory", signedAt: "2026-09-12T18:40:00+05:30" },
    ],
    allPartiesSigned: true,
    ...o,
});

const app = {
    companyName: "Sharma Battery House",
    gstNumber: "27ABCDE1234F1Z5",
    providerDocumentId: "DID2609A",
    manualMode: false,
};

describe("checkExecutedAgreement", () => {
    it("verifies a matching e-sign upload and takes the LAST signature as the signed day", () => {
        const r = checkExecutedAgreement({ application: app, docs: [doc()], digio: null });
        expect(r.verdict).toBe("verified");
        expect(r.signedOn).toBe("2026-09-12");
    });

    it("reads several audit trails together", () => {
        const trail = doc({ kind: "audit_trail", dealerName: null, gstin: null, signers: [{ name: "X", signedAt: "2026-09-13T09:00:00+05:30" }] });
        const r = checkExecutedAgreement({ application: app, docs: [doc(), trail], digio: null });
        expect(r.verdict).toBe("verified");
        expect(r.signedOn).toBe("2026-09-13");
    });

    it("flags another dealer's document id, GSTIN or name", () => {
        expect(checkExecutedAgreement({ application: app, docs: [doc({ documentId: "DIDOTHER" })], digio: null }).verdict).toBe("mismatch");
        expect(checkExecutedAgreement({ application: app, docs: [doc({ gstin: "29ZZZZZ9999Z1Z1" })], digio: null }).verdict).toBe("mismatch");
        expect(checkExecutedAgreement({ application: app, docs: [doc({ dealerName: "Gupta Motors" })], digio: null }).verdict).toBe("mismatch");
    });

    it("an e-sign upload with no document id needs Digio to say completed", () => {
        const noId = doc({ documentId: null });
        expect(checkExecutedAgreement({ application: app, docs: [noId], digio: null }).verdict).toBe("mismatch");
        expect(
            checkExecutedAgreement({ application: app, docs: [noId], digio: { status: "completed", signerNames: [] } }).verdict,
        ).toBe("verified");
    });

    it("a paper (manual) agreement needs no Digio tie", () => {
        const paper = doc({ documentId: null, referenceNumber: "PA-17" });
        const r = checkExecutedAgreement({ application: { ...app, providerDocumentId: null, manualMode: true }, docs: [paper], digio: null });
        expect(r.verdict).toBe("verified");
        expect(r.referenceNumber).toBe("PA-17");
    });

    it("unsigned parties and unreadable files are not verified", () => {
        expect(checkExecutedAgreement({ application: app, docs: [doc({ allPartiesSigned: false })], digio: null }).verdict).toBe("mismatch");
        expect(checkExecutedAgreement({ application: app, docs: [doc({ ok: false })], digio: null }).verdict).toBe("unreadable");
    });
});

describe("helpers", () => {
    it("toIsoDay reads the usual formats as an IST day", () => {
        expect(toIsoDay("12/09/2026")).toBe("2026-09-12");
        expect(toIsoDay("2026-09-12T20:00:00Z")).toBe("2026-09-13");
        expect(toIsoDay("nonsense")).toBeNull();
    });
    it("nameOverlap ignores Pvt / Ltd noise", () => {
        expect(nameOverlap("Sharma Battery House Pvt Ltd", "SHARMA BATTERY HOUSE")).toBe(1);
        expect(nameOverlap("Gupta Motors", "Sharma Battery House")).toBe(0);
    });
});
