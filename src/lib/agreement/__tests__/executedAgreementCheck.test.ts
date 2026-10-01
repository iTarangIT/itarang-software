import { describe, expect, it } from "vitest";
import {
    checkExecutedAgreement,
    namesMatch,
    toIsoDay,
    type ExtractedAgreementDoc,
} from "@/lib/agreement/executedAgreementCheck";

const doc = (o: Partial<ExtractedAgreementDoc> = {}): ExtractedAgreementDoc => ({
    kind: "signed_agreement",
    fileName: "agreement.pdf",
    ok: true,
    documentType: "dealer_agreement",
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

// A Digio audit trail: carries the document ID, not the dealer's name or GSTIN.
const trail = (o: Partial<ExtractedAgreementDoc> = {}): ExtractedAgreementDoc =>
    doc({ kind: "audit_trail", fileName: "trail.pdf", documentType: "audit_trail", dealerName: null, gstin: null, ...o });

const app = {
    companyName: "Sharma Battery House",
    gstNumber: "27ABCDE1234F1Z5",
    providerDocumentId: "DID2609A",
    manualMode: false,
};
const paperApp = { ...app, providerDocumentId: null, manualMode: true };

const check = (docs: ExtractedAgreementDoc[], extra: Partial<Parameters<typeof checkExecutedAgreement>[0]> = {}) =>
    checkExecutedAgreement({ application: app, docs, digio: null, today: "2026-10-01", ...extra });

describe("checkExecutedAgreement", () => {
    it("verifies a matching e-sign upload and takes the LAST signature as the signed day", () => {
        const r = check([doc()]);
        expect(r.verdict).toBe("verified");
        expect(r.signedOn).toBe("2026-09-12");
    });

    it("reads several audit trails together", () => {
        const second = trail({ fileName: "trail-2.pdf", signers: [{ name: "X", signedAt: "2026-09-13T09:00:00+05:30" }] });
        const r = check([doc(), trail(), second]);
        expect(r.verdict).toBe("verified");
        expect(r.signedOn).toBe("2026-09-13");
    });

    it("flags another dealer's document id, GSTIN or name", () => {
        expect(check([doc({ documentId: "DIDOTHER" })]).verdict).toBe("mismatch");
        expect(check([doc({ gstin: "29ZZZZZ9999Z1Z1" })]).verdict).toBe("mismatch");
        expect(check([doc({ dealerName: "Gupta Motors" })]).verdict).toBe("mismatch");
    });

    it("an e-sign upload with no document id needs Digio to say completed", () => {
        const noId = doc({ documentId: null });
        expect(check([noId]).verdict).toBe("mismatch");
        expect(check([noId], { digio: { status: "completed", signerNames: [] } }).verdict).toBe("verified");
    });

    it("a paper (manual) agreement needs no Digio tie", () => {
        const paper = doc({ documentId: null, referenceNumber: "PA-17" });
        const r = check([paper], { application: paperApp });
        expect(r.verdict).toBe("verified");
        expect(r.referenceNumber).toBe("PA-17");
    });

    it("unsigned parties and unreadable files are not verified", () => {
        expect(check([doc({ allPartiesSigned: false })]).verdict).toBe("mismatch");
        expect(check([doc({ ok: false })]).verdict).toBe("unreadable");
    });

    // ── review 30 Sep, point 3 ────────────────────────────────────────────
    it("a file with a date but no readable name, GSTIN or document id does not pass", () => {
        const bare = doc({ documentId: null, dealerName: null, gstin: null });
        const r = check([bare], { digio: { status: "completed", signerNames: [] } });
        expect(r.verdict).toBe("mismatch");
        expect(r.reasons.join(" ")).toContain("nothing that ties it to this dealer");
        // Paper too: no Digio id to fall back on.
        expect(check([bare], { application: paperApp }).verdict).toBe("mismatch");
    });

    it("signing that could not be read is not assumed", () => {
        const r = check([doc({ allPartiesSigned: null })]);
        expect(r.verdict).toBe("mismatch");
        expect(r.reasons).toContain("No file shows that every party has signed.");
    });

    // ── point 5 ───────────────────────────────────────────────────────────
    it("one unreadable or junk file fails the upload even when the others are good", () => {
        const junk = trail({ ok: false, documentType: "other", fileName: "invoice.pdf", documentId: null, signers: [] });
        const r = check([doc(), junk]);
        expect(r.verdict).toBe("mismatch");
        expect(r.reasons).toContain('"invoice.pdf" is not a dealer agreement or an audit trail.');

        const blurred = trail({ ok: false, documentType: null, fileName: "scan.pdf" });
        expect(check([doc(), blurred]).reasons).toContain('"scan.pdf" could not be read.');
    });

    it("a file in the wrong slot is refused", () => {
        // A second copy of the agreement dropped into the audit-trail slot.
        const r = check([doc(), doc({ kind: "audit_trail", fileName: "copy.pdf" })]);
        expect(r.verdict).toBe("mismatch");
        expect(r.reasons.join(" ")).toContain("uploaded as the audit trail");
    });

    it("an audit trail of another Digio document is refused", () => {
        expect(check([doc(), trail({ documentId: "DIDOTHER" })]).verdict).toBe("mismatch");
    });

    // ── point 6 ───────────────────────────────────────────────────────────
    it("a typed date or reference that differs from the document is a mismatch", () => {
        const paper = doc({ documentId: null, referenceNumber: "PA-17" });
        const run = (typed: { signedOn: string | null; referenceNumber: string | null }) =>
            check([paper], { application: paperApp, typed });

        expect(run({ signedOn: "2026-09-12", referenceNumber: "pa 17" }).verdict).toBe("verified");
        expect(run({ signedOn: "2026-08-01", referenceNumber: null }).verdict).toBe("mismatch");
        expect(run({ signedOn: null, referenceNumber: "PA-99" }).verdict).toBe("mismatch");
        // A typed date cannot stand in for one the system could not read.
        const undated = doc({ documentId: null, agreementDate: null, signers: [] });
        expect(check([undated], { application: paperApp, typed: { signedOn: "2026-09-12", referenceNumber: null } }).verdict).toBe("mismatch");
    });

    it("future signing dates are refused, read or typed", () => {
        expect(check([doc({ signers: [{ name: "A", signedAt: "2026-11-01T10:00:00+05:30" }] })]).verdict).toBe("mismatch");
        expect(check([doc()], { typed: { signedOn: "2026-12-01", referenceNumber: null } }).verdict).toBe("mismatch");
    });
});

describe("helpers", () => {
    it("toIsoDay reads the usual formats as an IST day", () => {
        expect(toIsoDay("12/09/2026")).toBe("2026-09-12");
        expect(toIsoDay("2026-09-12T20:00:00Z")).toBe("2026-09-13");
        expect(toIsoDay("nonsense")).toBeNull();
    });

    it("namesMatch ignores Pvt / Ltd noise", () => {
        expect(namesMatch("Sharma Battery House Pvt Ltd", "SHARMA BATTERY HOUSE")).toBe(true);
        expect(namesMatch("M/s Shree Balaji Motors", "Balaji Motor")).toBe(true);
        expect(namesMatch("Gupta Motors", "Sharma Battery House")).toBe(false);
    });

    // ── point 4 ───────────────────────────────────────────────────────────
    it("namesMatch is not fooled by shared trade words", () => {
        expect(namesMatch("Gupta Battery", "Sharma Battery")).toBe(false);
        expect(namesMatch("Gupta Battery", "Gupta Motors")).toBe(false);
        expect(namesMatch("Gupta Traders", "Gupta Enterprises")).toBe(false);
        expect(namesMatch("Battery House", "Sharma Battery House")).toBe(false);
        expect(namesMatch("EV Motors", "EV Motors Pvt Ltd")).toBe(true);
        expect(namesMatch("Sharma Batteries", "Sharma Battery House")).toBe(true);
        expect(namesMatch(null, "Sharma Battery House")).toBe(false);
    });
});
