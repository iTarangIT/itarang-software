// Does an uploaded, manually executed dealer agreement (and its audit trails)
// belong to THIS dealer and show a completed signing? (tracker ID 55,
// 29 Sep 2026; tightened 01 Oct 2026 after the 30 Sep review). PURE — no DB, no
// network — so the rule is unit-tested; the reading (Gemini) and Digio lookups
// live in readExecutedAgreement.ts.
//
//   verified    EVERY file was read, is the kind of document its slot asks for,
//               carries something that ties it to this dealer, and nothing read
//               contradicts the application, Digio or what the admin typed. The
//               upload completes the agreement and its dates are written from
//               the documents.
//   mismatch    anything less. Nothing is completed by the uploader: the files
//               wait for a SECOND approver (dealer_agreement_override_requests,
//               E-318).
//   unreadable  nothing could be read from any file. Same handling as mismatch.
//
// A check that could not be made is a failure, not a pass: a file with a date
// but no readable document ID, GSTIN or business name does not verify.

export type ExtractedAgreementDoc = {
    kind: "signed_agreement" | "audit_trail";
    /** As uploaded — names the file in a reason. */
    fileName?: string | null;
    ok: boolean;
    /** What the reader says the file is; null when it could not tell. */
    documentType?: "dealer_agreement" | "audit_trail" | "other" | null;
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
    /** What the admin typed next to the upload. Checked against what was read. */
    typed?: { signedOn: string | null; referenceNumber: string | null };
    /** Today as an IST day (YYYY-MM-DD) — a signing date after it is refused. */
    today?: string | null;
};

export type AgreementCheckResult = {
    verdict: "verified" | "mismatch" | "unreadable";
    reasons: string[];
    /** The day the agreement was fully executed (last signature) AS READ, YYYY-MM-DD. */
    signedOn: string | null;
    documentId: string | null;
    /** The reference number AS READ from the paper. */
    referenceNumber: string | null;
    signers: Array<{ name: string | null; signedAt: string | null }>;
};

/**
 * Minimum length of the reason given when asking for a second approval. Here
 * (the client-safe module) because the review page enforces it too.
 */
export const OVERRIDE_REASON_MIN = 20;

const norm = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// Legal form and honorifics — carry no identity, dropped before comparing.
const NOISE = new Set([
    "PVT", "PRIVATE", "LTD", "LIMITED", "LLP", "OPC", "THE", "AND", "CO", "COMPANY", "MS",
    "SHREE", "SHRI", "SRI", "SREE",
]);
// Trade words half the dealer book shares. They must still agree ("Gupta
// Battery" is not "Gupta Motors") but can never be the reason two names match
// ("Gupta Battery" is not "Sharma Battery"). Singular — see nameTokens().
const GENERIC = new Set([
    "BATTERY", "MOTOR", "EV", "AUTO", "AUTOMOBILE", "AUTOMOTIVE", "ELECTRIC", "ELECTRICAL", "ELECTRONIC",
    "ENERGY", "POWER", "SOLAR", "GREEN", "MOBILITY", "VEHICLE", "RICKSHAW", "ERICKSHAW", "CYCLE", "TYRE",
    "ENTERPRISE", "TRADER", "TRADING", "AGENCY", "STORE", "SHOP", "SALE", "SERVICE", "SOLUTION", "INDUSTRY",
    "CENTRE", "CENTER", "HOUSE", "WORLD", "POINT", "ZONE", "HUB", "MART", "INDIA", "NEW",
]);

const singular = (t: string) =>
    t.endsWith("IES") && t.length > 4
        ? `${t.slice(0, -3)}Y`
        : t.endsWith("S") && !t.endsWith("SS") && t.length > 3
          ? t.slice(0, -1)
          : t;

function nameTokens(s: string | null | undefined): string[] {
    const tokens = (s ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9 ]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1 && !NOISE.has(t))
        .map(singular);
    return [...new Set(tokens)];
}

/**
 * Same business? Every word of the shorter name must be in the longer one, and
 * unless the two are word-for-word the same, at least one of those words must
 * be distinctive (not a trade word like BATTERY / MOTORS / EV).
 */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
    const x = nameTokens(a);
    const y = nameTokens(b);
    if (x.length === 0 || y.length === 0) return false;
    const [short, long] = x.length <= y.length ? [x, new Set(y)] : [y, new Set(x)];
    if (!short.every((t) => long.has(t))) return false;
    if (short.length === long.size) return true;
    return short.some((t) => !GENERIC.has(t));
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

const SLOT = {
    signed_agreement: { type: "dealer_agreement", label: "signed agreement" },
    audit_trail: { type: "audit_trail", label: "audit trail" },
} as const;

export function checkExecutedAgreement(input: AgreementCheckInput): AgreementCheckResult {
    const { application: app, docs, digio, typed, today } = input;
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
    const appDocId = norm(app.providerDocumentId);
    const appGstin = norm(app.gstNumber);

    // ── every file, on its own ────────────────────────────────────────────
    // One good file never carries a bad one: a junk PDF in the audit-trail slot
    // fails the upload even when the signed agreement is perfect.
    docs.forEach((d, i) => {
        const slot = SLOT[d.kind];
        const name = d.fileName ? `"${d.fileName}"` : `File ${i + 1} (${slot.label})`;

        if (!d.ok) {
            reasons.push(
                d.documentType === "other"
                    ? `${name} is not a dealer agreement or an audit trail.`
                    : `${name} could not be read.`,
            );
            return;
        }
        if (d.documentType !== slot.type) {
            reasons.push(
                `${name} was uploaded as the ${slot.label} but does not read as one${
                    d.documentType ? ` (it looks like ${d.documentType === "audit_trail" ? "an audit trail" : "a dealer agreement"})` : ""
                }.`,
            );
        }

        const idRead = norm(d.documentId);
        const gstinRead = norm(d.gstin);
        const idOk = !!appDocId && !!idRead && idRead === appDocId;
        const gstinOk = !!appGstin && !!gstinRead && gstinRead === appGstin;
        const nameOk = !!app.companyName && !!d.dealerName && namesMatch(d.dealerName, app.companyName);

        if (appDocId && idRead && !idOk) {
            reasons.push(`${name} names Digio document ${d.documentId}, not this dealer's ${app.providerDocumentId}.`);
        }
        if (appGstin && gstinRead && !gstinOk) {
            reasons.push(`${name} shows GSTIN ${d.gstin}, not the dealer's ${app.gstNumber}.`);
        }
        if (app.companyName && d.dealerName && !nameOk) {
            reasons.push(`${name} names "${d.dealerName}", not "${app.companyName}".`);
        }
        if (!idOk && !gstinOk && !nameOk) {
            reasons.push(
                `${name} has nothing that ties it to this dealer — no matching document ID, GSTIN or business name could be read from it.`,
            );
        }
    });

    // ── the signing ───────────────────────────────────────────────────────
    if (read.some((d) => d.allPartiesSigned === false)) {
        reasons.push("A document shows that not every party has signed.");
    } else if (!read.some((d) => d.allPartiesSigned === true)) {
        reasons.push("No file shows that every party has signed.");
    }

    if (!app.manualMode) {
        // An e-sign rescue must tie to the Digio document: either a file names
        // it, or Digio itself says it is complete.
        const idMatches = read.some((d) => !!appDocId && norm(d.documentId) === appDocId);
        const digioDone = (digio?.status ?? "").toLowerCase() === "completed";
        if (!idMatches && !digioDone) {
            reasons.push(
                "Could not tie the upload to the Digio document: no file shows its document ID and Digio does not report it completed.",
            );
        }
    }

    if (!signedOn) {
        reasons.push("No signing date could be read.");
    } else if (today && signedOn > today) {
        reasons.push(`The signing date read from the documents (${signedOn}) is in the future.`);
    }

    // ── what the admin typed ──────────────────────────────────────────────
    // A typed value never silently replaces a read one. If they differ, a
    // second person decides which is right.
    if (typed?.signedOn) {
        if (today && typed.signedOn > today) {
            reasons.push(`The signed-on date you entered (${typed.signedOn}) is in the future.`);
        }
        if (signedOn && typed.signedOn !== signedOn) {
            reasons.push(`You entered ${typed.signedOn} as the signing date, but the documents show ${signedOn}.`);
        }
    }
    if (typed?.referenceNumber && referenceNumber && norm(typed.referenceNumber) !== norm(referenceNumber)) {
        reasons.push(
            `You entered reference "${typed.referenceNumber}", but the document shows "${referenceNumber}".`,
        );
    }

    return {
        verdict: reasons.length ? "mismatch" : "verified",
        reasons,
        signedOn,
        documentId,
        referenceNumber,
        signers,
    };
}
