/**
 * 20 Nov — "Uploading a PDF should not automatically mark consent as signed."
 *
 * A manually-signed consent (print → customer signs → upload) used to be taken
 * at face value: any PDF or photo the dealer / operator sent was stored as the
 * signed consent and, with KYC automation on, auto-verified two minutes later.
 * This reads the upload with Gemini (the same key + model the WhatsApp document
 * pipeline uses) and answers three questions: is it our consent form, is it
 * readable, and is there a handwritten signature (or thumb impression) in a
 * SIGNATURE box.
 *
 * Verdicts:
 *   signed      — accept; the auto-verify clock may start.
 *   unsigned    — refuse: the form came back without a signature.
 *   not_consent — refuse: some other document was uploaded.
 *   unreadable  — refuse: ask for a clearer scan / photo.
 *   unknown     — the check itself failed (no key, network, odd file). Accept
 *                 for HUMAN review only: never auto-verified (no clock).
 */
import { readDocumentWithPrompt } from "@/lib/whatsapp/extraction";

import { consentBelongsToFile, type ConsentExpected, type ConsentOwnership } from "./consent-ownership";

/** 23 Nov: + wrong_file — the form printed for ANOTHER customer / file (refused). */
export type ConsentSignatureVerdict = "signed" | "unsigned" | "not_consent" | "unreadable" | "unknown" | "wrong_file";

export interface ConsentSignatureCheck {
  verdict: ConsentSignatureVerdict;
  /** One line for the admin (stored on consent_records.reviewer_notes). */
  note: string;
  /** Dealer / operator facing reason when refused. */
  message?: string;
  /** 23 Nov (point 1): is it THIS file's form? Absent when the check could not run. */
  ownership?: ConsentOwnership;
}

const PROMPT = `You are checking a scanned or photographed customer CONSENT FORM before it is accepted.

The genuine form is issued by "iTarang Technologies LLP". Its pages are titled
"Consent Form for Data Processing", "Consumer Communication Consent" and similar, mention DPDPA 2023,
carry a "Ref:" consent id, and EACH page ends with a block of three boxes labelled NAME, DATE and SIGNATURE.
In the blank form the SIGNATURE box only holds an empty line "___________".

Look at every page and answer in strict JSON:
{
  "is_consent_form": boolean,      // true only if this is that iTarang consent form (any page of it)
  "legible": boolean,              // false if too blurred / dark / cut off to judge
  "pages_seen": number,            // how many pages of the form you can see
  "signature_boxes_seen": number,  // SIGNATURE boxes you can see
  "signed_boxes": number,          // SIGNATURE boxes holding a handwritten signature, initials or a thumb impression
  "signature_present": boolean,    // true if at least one SIGNATURE box is really signed by hand
  "looks_digitally_added": boolean,// true if the "signature" is typed text or a pasted image, not ink
  "printed_lead_id": string|null,  // the id after "Lead:" in the "Ref: … | Lead: …" line, exactly as printed (e.g. LEAD-20261120-d476195a)
  "printed_consent_ref": string|null, // the id after "Ref:" (e.g. CONSENT-20261120-0042)
  "printed_customer_name": string|null, // the name after "Dear" / in the NAME box, as PRINTED (not handwritten); null if blank
  "reason": string                 // one short sentence
}
Typed text, the printed customer name, a stamp of the company or the empty line itself are NOT a signature.`;

export async function checkConsentSignature(
  buffer: Buffer,
  mimeType: string,
  /** 23 Nov (point 1): the file the upload must belong to. Omitted = signature only. */
  expected?: ConsentExpected,
): Promise<ConsentSignatureCheck> {
  const mime = normaliseMime(buffer, mimeType);
  if (!mime) {
    return { verdict: "unknown", note: "Signature check skipped: unsupported file type — needs a human check." };
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = await readDocumentWithPrompt(buffer, mime, PROMPT);
  } catch (err) {
    console.warn("[consent-signature-check] read failed", err instanceof Error ? err.message : String(err));
  }
  if (!parsed) {
    return { verdict: "unknown", note: "Signature check could not run (document reader unavailable) — needs a human check." };
  }

  const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "";
  const isForm = parsed.is_consent_form === true;
  const legible = parsed.legible !== false;
  const signed = parsed.signature_present === true && Number(parsed.signed_boxes ?? 1) > 0;
  const digital = parsed.looks_digitally_added === true;
  const boxes = Number(parsed.signature_boxes_seen ?? 0) || 0;
  const signedBoxes = Number(parsed.signed_boxes ?? 0) || 0;

  if (!legible) {
    return {
      verdict: "unreadable",
      note: `Signature check: unreadable upload. ${reason}`.trim(),
      message: "The file is not clear enough to check the customer's signature. Please upload a clearer scan or photo of the signed consent form.",
    };
  }
  if (!isForm) {
    return {
      verdict: "not_consent",
      note: `Signature check: not the iTarang consent form. ${reason}`.trim(),
      message: "This doesn't look like the iTarang consent form. Please upload the consent form we sent, signed by the customer.",
    };
  }
  // 23 Nov (point 1): the form must be THIS customer's — another file's signed
  // consent is refused even when it is properly signed.
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const own = expected
    ? consentBelongsToFile(
        { leadId: str(parsed.printed_lead_id), consentRef: str(parsed.printed_consent_ref), customerName: str(parsed.printed_customer_name) },
        expected,
      )
    : null;
  if (own?.ownership === "mismatch") {
    return {
      verdict: "wrong_file",
      ownership: "mismatch",
      note: `Ownership check: ${own.note}`,
      message:
        "This signed consent form belongs to a different customer's file. Please upload the consent form printed for this customer (its \"Lead:\" number and name must match this file).",
    };
  }

  if (!signed || digital) {
    return {
      verdict: "unsigned",
      note: `Signature check: no handwritten signature found${digital ? " (typed / pasted signature)" : ""}. ${reason}`.trim(),
      message:
        "The customer's signature is missing on the consent form. Please get the customer to sign in the SIGNATURE box on every page, then upload the signed form again.",
    };
  }
  return {
    verdict: "signed",
    ownership: own?.ownership,
    note:
      `Signature check: customer signature found (${signedBoxes}/${boxes || "?"} signature boxes signed).` +
      (own ? ` Ownership check: ${own.note}` : ""),
  };
}

/** Gemini takes PDFs and images; sniff the bytes when the declared type is vague. */
function normaliseMime(buffer: Buffer, declared: string | null | undefined): string | null {
  const d = (declared ?? "").toLowerCase().split(";")[0].trim();
  if (d === "application/pdf" || d.startsWith("image/")) return d;
  if (buffer.length >= 4) {
    const head = buffer.subarray(0, 4);
    if (head.toString("latin1") === "%PDF") return "application/pdf";
    if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
    if (head[0] === 0x89 && head[1] === 0x50) return "image/png";
    if (head.toString("latin1") === "RIFF") return "image/webp";
  }
  return null;
}

/** The content type to store the upload under (images were being saved as .pdf). */
export function storedConsentFile(buffer: Buffer, declared: string | null | undefined): { mime: string; ext: string } {
  const m = normaliseMime(buffer, declared) ?? "application/pdf";
  if (m === "image/jpeg" || m === "image/jpg") return { mime: "image/jpeg", ext: "jpg" };
  if (m === "image/png") return { mime: "image/png", ext: "png" };
  if (m === "image/webp") return { mime: "image/webp", ext: "webp" };
  if (m.startsWith("image/")) return { mime: m, ext: m.slice(6) || "img" };
  return { mime: "application/pdf", ext: "pdf" };
}
