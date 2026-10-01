// The engine behind tracker ID 55: READ an uploaded, manually executed dealer
// agreement and its audit trail(s), and check them against the application and
// Digio. The decision itself is the pure checkExecutedAgreement().
//
// Reading is Gemini (the same client the WhatsApp onboarding reader uses) with
// a prompt of its own. Digio is asked about provider_document_id when there is
// one. Neither ever throws: an unreadable file comes back ok=false and the
// matcher fails the upload on it.

import { readDocumentWithPrompt } from "@/lib/whatsapp/extraction";
import { fetchDigioDocumentStatus } from "@/lib/digio";
import {
    checkExecutedAgreement,
    type AgreementCheckResult,
    type ExtractedAgreementDoc,
} from "@/lib/agreement/executedAgreementCheck";

const PROMPT = [
    "You are reading an executed (signed) Indian dealer agreement between iTarang Technologies and a battery dealer, or the e-sign AUDIT TRAIL of one (e.g. from Digio).",
    "Return ONLY a JSON object, no markdown, with EXACTLY this shape:",
    "{",
    '  "document_type": <"dealer_agreement" | "audit_trail" | "other">,',
    '  "legible": <true | false>,',
    '  "document_id": <the e-sign document ID printed on it (Digio IDs look like "DID…"), or null>,',
    '  "dealer_name": <the dealer / business party\'s legal name, or null>,',
    '  "dealer_gstin": <the dealer\'s 15-character GSTIN, no spaces, or null>,',
    '  "agreement_date": <the agreement / execution date as printed, or null>,',
    '  "reference_number": <an agreement or reference number written on a paper agreement, or null>,',
    '  "signers": [ { "name": <signer name>, "signed_at": <date-time of that signature as printed, ISO 8601 if possible> } ],',
    '  "all_parties_signed": <true if every party shown has signed / the trail says completed, false if a party is shown as pending, null if unclear>',
    "}",
    "Rules: read values exactly as printed; never guess; null for anything not present. Include every signer the document lists.",
    'document_type is "other" for anything that is neither the agreement itself nor an e-sign audit trail (an invoice, an ID card, a blank or unrelated page).',
    "iTarang is the OTHER party: never return iTarang's own name or GSTIN as dealer_name / dealer_gstin.",
].join("\n");

function str(v: unknown): string | null {
    return typeof v === "string" && v.trim() ? v.trim() : null;
}

const DOC_TYPES = new Set(["dealer_agreement", "audit_trail", "other"]);

// iTarang's own GSTIN is printed on every agreement (dealer-agreement-template.ts).
// The prompt says not to return it as the dealer's; this makes sure.
const ITARANG_GSTIN = "06AALFI7813E1ZE";

export async function readAgreementFile(
    buffer: Buffer,
    kind: ExtractedAgreementDoc["kind"],
    fileName: string | null = null,
): Promise<ExtractedAgreementDoc> {
    const parsed = await readDocumentWithPrompt(buffer, "application/pdf", PROMPT).catch(() => null);
    const documentType = (
        parsed && DOC_TYPES.has(String(parsed.document_type)) ? parsed.document_type : null
    ) as ExtractedAgreementDoc["documentType"];
    if (!parsed || parsed.legible === false || documentType === "other") {
        return {
            kind,
            fileName,
            ok: false,
            documentType,
            documentId: null,
            dealerName: null,
            gstin: null,
            agreementDate: null,
            referenceNumber: null,
            signers: [],
            allPartiesSigned: null,
        };
    }
    const gstin = str(parsed.dealer_gstin)?.replace(/\s/g, "").toUpperCase() ?? null;
    const signers = Array.isArray(parsed.signers)
        ? (parsed.signers as Array<Record<string, unknown>>).map((s) => ({
              name: str(s?.name),
              signedAt: str(s?.signed_at),
          }))
        : [];
    return {
        kind,
        fileName,
        ok: true,
        documentType,
        documentId: str(parsed.document_id),
        dealerName: str(parsed.dealer_name),
        gstin: gstin && gstin !== ITARANG_GSTIN ? gstin : null,
        agreementDate: str(parsed.agreement_date),
        referenceNumber: str(parsed.reference_number),
        signers,
        allPartiesSigned: typeof parsed.all_parties_signed === "boolean" ? parsed.all_parties_signed : null,
    };
}

async function digioView(documentId: string | null) {
    if (!documentId) return null;
    try {
        const d = (await fetchDigioDocumentStatus(documentId)) as Record<string, unknown> | null;
        if (!d) return null;
        const parties = Array.isArray(d.signing_parties) ? (d.signing_parties as Array<Record<string, unknown>>) : [];
        return {
            status: str(d.agreement_status) ?? str(d.status),
            signerNames: parties.map((p) => str(p.name)).filter((n): n is string => !!n),
        };
    } catch {
        return null;
    }
}

/** Today as an IST calendar day, YYYY-MM-DD. */
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

export async function checkUploadedAgreement(input: {
    application: {
        company_name: string | null;
        gst_number: string | null;
        provider_document_id: string | null;
    };
    manualMode: boolean;
    files: Array<{ kind: ExtractedAgreementDoc["kind"]; buffer: Buffer; fileName?: string | null }>;
    /** What the admin typed with the upload — checked against what is read. */
    typed?: { signedOn: string | null; referenceNumber: string | null };
}): Promise<{ result: AgreementCheckResult; docs: ExtractedAgreementDoc[] }> {
    const [docs, digio] = await Promise.all([
        Promise.all(input.files.map((f) => readAgreementFile(f.buffer, f.kind, f.fileName ?? null))),
        input.manualMode ? Promise.resolve(null) : digioView(input.application.provider_document_id),
    ]);
    const result = checkExecutedAgreement({
        application: {
            companyName: input.application.company_name,
            gstNumber: input.application.gst_number,
            providerDocumentId: input.application.provider_document_id,
            manualMode: input.manualMode,
        },
        docs,
        digio,
        typed: input.typed,
        today: istToday(),
    });
    return { result, docs };
}
