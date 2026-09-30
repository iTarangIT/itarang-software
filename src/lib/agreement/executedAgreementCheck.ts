// Does an uploaded, manually executed dealer agreement (and its audit trails)
// belong to THIS dealer and show a completed signing? (tracker ID 55,
// 29 Sep 2026). PURE — no DB, no network — so the rule is unit-tested; the
// reading (Gemini) and Digio lookups live in readExecutedAgreement.ts.
//
//   verified    every check that could be made passed; the upload may complete
//               the agreement and its dates are written from the documents.
//   mismatch    a document names another Digio document, another GSTIN or
//               another business, or not every party has signed. The files
//               are kept; the agreement is completed only if an admin
//               confirms the mismatch with a reason.
//   unreadable  nothing could be read from any file. Same handling as mismatch.

export type ExtractedAgreementDoc = {
    kind: "signed_agreement" | "audit_trail";
    ok: boolean;
    documentId: string | null;
    dealerName: string | null;
    gstin: string | null;
    agreementDate: string | null;
    referenceNumber: string | null;
    signers: Array<{ name: string | null; signedAt: string | null }>;
    allPartiesSigned: boolean | null;
};

export type AgreementCheckInput = {
    application: {
        companyName: string | null;
        gstNumber: string | null;
        providerDocumentId: string | null;
        manualMode: boolean;
    };
    docs: ExtractedAgreementDoc[];
    /** Digio's own view of provider_document_id, when it could be fetched. */
    digio: { status: string | null; signerNames: string[] } | null;
};

export type AgreementCheckResult = {
    verdict: "verified" | "mismatch" | "unreadable";
    reasons: string[];
    /** The day the agreement was fully executed (last signature), YYYY-MM-DD. */
    signedOn: string | null;
    documentId: string | null;
    referenceNumber: string | null;
    signers: Array<{ name: string | null; signedAt: string | null }>;
};

const norm = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

const STOP = new Set(["PVT", "PRIVATE", "LTD", "LIMITED", "LLP", "THE", "AND", "CO", "COMPANY", "M/S", "MS", "ENTERPRISES", "ENTERPRISE", "TRADERS", "TRADING"]);
function nameTokens(s: string | null | undefined): string[] {
    return (s ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9 ]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Share of the shorter name's words found in the other (0..1). */
export function nameOverlap(a: string | null | undefined, b: string | null | undefined): number {
    const x = nameTokens(a);
    const y = new Set(nameTokens(b));
    if (x.length === 0 || y.size === 0) return 0;
    const [short, long] = x.length <= y.size ? [x, y] : [[...y], new Set(x)];
    const hit = short.filter((t) => long.has(t)).length;
    return hit / short.length;
}

/** "2026-09-12T10:31:00+05:30", "12/09/2026", "12-Sep-2026" → "2026-09-12" (IST day), else null. */
export function toIsoDay(raw: string | null | undefined): string | null {
    const s = (raw ?? "").trim();
    if (!s) return null;
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) {
        if (s.length > 10) {
            const d = new Date(s);
            if (!Number.isNaN(d.getTime())) {
                return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
            }
        }
        return `${m[1]}-${m[2]}-${m[3]}`;
    }
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
    if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
    return null;
}

export function checkExecutedAgreement(input: AgreementCheckInput): AgreementCheckResult {
    const { application: app, docs, digio } = input;
    const read = docs.filter((d) => d.ok);
    const signers = read.flatMap((d) => d.signers).filter((s) => s.name || s.signedAt);
    const documentId = read.map((d) => d.documentId).find(Boolean) ?? null;
    const referenceNumber = read.map((d) => d.referenceNumber).find(Boolean) ?? null;

    const days = signers.map((s) => toIsoDay(s.signedAt)).filter((d): d is string => !!d).sort();
    const signedOn =
        days[days.length - 1] ?? read.map((d) => toIsoDay(d.agreementDate)).find(Boolean) ?? null;

    if (read.length === 0) {
        return {
            verdict: "unreadable",
            reasons: ["None of the uploaded files could be read."],
            signedOn: null,
            documentId: null,
            referenceNumber: null,
            signers: [],
        };
    }

    const reasons: string[] = [];

    if (app.providerDocumentId) {
        const other = read.find((d) => d.documentId && norm(d.documentId) !== norm(app.providerDocumentId));
        if (other) {
            reasons.push(
                `A document names Digio document ${other.documentId}, not this dealer's ${app.providerDocumentId}.`,
            );
        }
    }

    const gstin = norm(app.gstNumber);
    if (gstin) {
        const other = read.find((d) => d.gstin && norm(d.gstin) !== gstin);
        if (other) reasons.push(`A document shows GSTIN ${other.gstin}, not the dealer's ${app.gstNumber}.`);
    }

    const names = read.map((d) => d.dealerName).filter((n): n is string => !!n);
    if (app.companyName && names.length > 0 && !names.some((n) => nameOverlap(n, app.companyName) >= 0.5)) {
        reasons.push(`The documents name "${names[0]}", not "${app.companyName}".`);
    }

    if (read.some((d) => d.allPartiesSigned === false)) {
        reasons.push("A document shows that not every party has signed.");
    }

    if (!app.manualMode) {
        // An e-sign rescue must tie to the Digio document: either a file names
        // it, or Digio itself says it is complete.
        const idMatches = !!documentId && !!app.providerDocumentId && norm(documentId) === norm(app.providerDocumentId);
        const digioDone = (digio?.status ?? "").toLowerCase() === "completed";
        if (!idMatches && !digioDone) {
            reasons.push(
                "Could not tie the upload to the Digio document: no file shows its document ID and Digio does not report it completed.",
            );
        }
    }

    if (!signedOn) reasons.push("No signing date could be read.");

    return {
        verdict: reasons.length ? "mismatch" : "verified",
        reasons,
        signedOn,
        documentId,
        referenceNumber,
        signers,
    };
}
