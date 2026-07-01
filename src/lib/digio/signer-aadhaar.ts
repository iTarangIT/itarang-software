// Normalize Digio e-sign payloads (webhook push + document-status pull) into a
// single shape, and extract the SIGNER'S Aadhaar from the place Digio actually
// puts it.
//
// THE BUG THIS FIXES: Digio's signed payload carries the signer's Aadhaar under
//   payload.document.signing_parties[].pki_signature_details.aadhaar_suffix
// (the last 4 digits), alongside the real Aadhaar-holder `name` and Digio's own
// `name_validation_score`. Earlier code read a top-level
// `signing_parties[].aadhaar_masked` that the real payload does NOT contain, so
// the Aadhaar-match gate always got `null` and silently passed every signature.
//
// This module reads the documented production envelope (payload.document.…) AND
// the flatter sandbox/legacy shapes, so the gate finally has something to compare.
// Ref: https://documentation.digio.in/digisign/api_integration/webhooks/

export interface DigioSignerIdentity {
  /** Email or phone Digio used to address the signer. */
  identifier: string | null;
  /** The name WE registered for this signing party. */
  name: string | null;
  /** Per-party signing status, lower-cased. */
  status: string | null;
  /** Last 4 digits of the Aadhaar that ACTUALLY signed (pki_signature_details.aadhaar_suffix). */
  aadhaarSuffix: string | null;
  /** Real Aadhaar-holder name, as returned by UIDAI via Digio. */
  aadhaarName: string | null;
  /** Digio's name-match score (0-100) comparing the Aadhaar name to the registered name. */
  nameValidationScore: number | null;
}

export interface NormalizedDigioDoc {
  documentId: string | null;
  agreementStatus: string | null;
  parties: DigioSignerIdentity[];
}

type Json = Record<string, unknown>;

/** Treat an unknown value as a plain object for safe property access. */
function asObj(v: unknown): Json {
  return v && typeof v === "object" ? (v as Json) : {};
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return null;
}

/** Pull the signer's Aadhaar identity from one signing-party object. */
export function extractSignerAadhaar(party: unknown): {
  suffix: string | null;
  name: string | null;
  nameScore: number | null;
} {
  const p = asObj(party);
  const pki = asObj(p.pki_signature_details ?? p.pkiSignatureDetails);
  const suffix = firstString(
    pki.aadhaar_suffix,
    pki.aadhaarSuffix,
    p.aadhaar_suffix,
    // legacy/sandbox fallbacks (kept so older payloads still compare)
    p.aadhaar_masked,
    p.signer_aadhaar,
    p.aadhaar,
  );
  const name = firstString(pki.name, pki.display_name);
  const nameScore = firstNumber(
    pki.name_validation_score,
    pki.nameValidationScore,
  );
  return { suffix, name, nameScore };
}

/** Locate the signing-parties array across the prod envelope and flat shapes. */
function extractParties(body: unknown): unknown[] {
  const b = asObj(body);
  const doc = asObj(asObj(b.payload).document ?? b.document ?? b);
  const candidates =
    doc.signing_parties ??
    doc.signingParties ??
    b.signing_parties ??
    b.signingParties ??
    b.signers ??
    [];
  return Array.isArray(candidates) ? candidates : [];
}

/**
 * Normalize a Digio webhook body OR a document-status response into a single
 * shape. Handles the documented `payload.document.…` envelope and the flat
 * `{ id, agreement_status, signing_parties }` shape interchangeably.
 */
export function normalizeDigioDoc(body: unknown): NormalizedDigioDoc {
  const b = asObj(body);
  const doc = asObj(asObj(b.payload).document ?? b.document ?? b);

  // `doc` already resolves to payload.document when present, so doc.id covers the
  // nested prod envelope; the rest are flat sandbox/legacy fallbacks.
  const documentId = firstString(
    doc.id,
    b.digio_doc_id,
    b.document_id,
    b.id,
  );

  const agreementStatus = firstString(
    doc.agreement_status,
    doc.status,
    b.agreement_status,
    b.status,
  )?.toLowerCase() ?? null;

  const parties: DigioSignerIdentity[] = extractParties(body).map((raw) => {
    const p = asObj(raw);
    const { suffix, name, nameScore } = extractSignerAadhaar(raw);
    return {
      identifier: firstString(
        p.identifier,
        p.email,
        p.signer_email,
        p.signerIdentifier,
      ),
      name: firstString(p.name),
      status:
        firstString(p.status, p.signing_status, p.party_status)?.toLowerCase() ??
        null,
      aadhaarSuffix: suffix,
      aadhaarName: name,
      nameValidationScore: nameScore,
    };
  });

  return { documentId, agreementStatus, parties };
}

/**
 * The signer's Aadhaar identity for a single-signer document (the consent flow).
 * Prefers a party that exposes an Aadhaar suffix; otherwise the first party.
 */
export function getConsentSignerIdentity(body: unknown): {
  suffix: string | null;
  name: string | null;
  nameScore: number | null;
  identifier: string | null;
} {
  const { parties } = normalizeDigioDoc(body);
  const withSuffix = parties.find((p) => p.aadhaarSuffix);
  const party = withSuffix ?? parties[0] ?? null;
  return {
    suffix: party?.aadhaarSuffix ?? null,
    name: party?.aadhaarName ?? null,
    nameScore: party?.nameValidationScore ?? null,
    identifier: party?.identifier ?? null,
  };
}
