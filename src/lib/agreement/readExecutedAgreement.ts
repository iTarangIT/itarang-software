// The engine behind tracker ID 55: READ an uploaded, manually executed dealer
// agreement and its audit trail(s), and check them against the application and
// Digio. The decision itself is the pure checkExecutedAgreement().
//
// Reading is Gemini (the same client the WhatsApp onboarding reader uses) with
// a prompt of its own. Digio is asked about provider_document_id when there is
// one. Neither ever throws: an unreadable file comes back ok=false and the
// matcher reports "unreadable".

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
].join("\n");

function str(v: unknown): string | null {
    return typeof v === "string" && v.trim() ? v.trim() : null;
}

export async function readAgreementFile(
    buffer: Buffer,
    kind: ExtractedAgreementDoc["kind"],
): Promise<ExtractedAgreementDoc> {
    const parsed = await readDocumentWithPrompt(buffer, "application/pdf", PROMPT).catch(() => null);
    if (!parsed || parsed.legible === false || parsed.document_type === "other") {
        return {
            kind,
            ok: false,
            documentId: null,
            dealerName: null,
            gstin: null,
            agreementDate: null,
            referenceNumber: null,
            signers: [],
            allPartiesSigned: null,
        };
    }
    const signers = Array.isArray(parsed.signers)
        ? (parsed.signers as Array<Record<string, unknown>>).map((s) => ({
              name: str(s?.name),
              signedAt: str(s?.signed_at),
          }))
        : [];
    return {
        kind,
        ok: true,
        documentId: str(parsed.document_id),
        dealerName: str(parsed.dealer_name),
        gstin: str(parsed.dealer_gstin)?.replace(/\s/g, "") ?? null,
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

export async function checkUploadedAgreement(input: {
    application: {
        company_name: string | null;
        gst_number: string | null;
        provider_document_id: string | null;
    };
    manualMode: boolean;
    files: Array<{ kind: ExtractedAgreementDoc["kind"]; buffer: Buffer }>;
}): Promise<{ result: AgreementCheckResult; docs: ExtractedAgreementDoc[] }> {
    const [docs, digio] = await Promise.all([
        Promise.all(input.files.map((f) => readAgreementFile(f.buffer, f.kind))),
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
    });
    return { result, docs };
}
