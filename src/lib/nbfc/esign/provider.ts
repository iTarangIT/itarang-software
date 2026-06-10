/**
 * Vendor-neutral e-sign provider PORT (E-166, Model B).
 *
 * The loan-agreement signing flow talks ONLY to this interface — never to Digio
 * or Leegality directly. Each provider is a self-describing adapter (see
 * registry.ts) selected per NBFC tenant. iTarang stays provider-agnostic:
 * adding a new provider is one adapter file implementing this contract.
 *
 * Canonical status is the two-layer model (§17.x): logic reads only the
 * canonical `signed | failed | in_progress`; the provider's raw status/payload
 * is display/audit only.
 *
 * Credentials are passed into every method (the adapter holds no tenant state),
 * resolved + decrypted by `loadProviderCredentials` (credentials.ts).
 */

export type CanonicalSignStatus = "in_progress" | "signed" | "failed";
export type EsignEnvironment = "sandbox" | "production";

/**
 * Resolved, decrypted credentials for one provider+tenant. `secrets` holds the
 * fields the adapter declared in its `credentialSchema` (registry.ts). `source`
 * lets the Digio adapter delegate to the existing global-env singleton path
 * unchanged when an NBFC has not brought its own keys.
 */
export interface EsignCreds {
  providerId: string;
  source: "global" | "tenant";
  environment: EsignEnvironment;
  secrets: Record<string, string>;
  /** Optional explicit base-URL override (else the adapter derives it). */
  baseUrl?: string;
}

/** Provider-agnostic signer (generalises DigioSigner). */
export interface EsignSigner {
  identifier: string; // email or 10-digit mobile
  name: string;
  reason: string;
  signType?: "aadhaar" | "electronic" | "dsc";
  /** Lower signs first when the provider supports sequential signing. */
  sequence?: number;
  signCoordinates?: { page: number; x: number; y: number; w?: number; h?: number };
}

export interface CreateFromPdfInput {
  fileData: string; // base64 PDF
  fileName: string;
  agreementRef: string; // opaque correlation ref (becomes the provider callback token)
  signers: EsignSigner[];
  expireInDays?: number;
  /** Where the provider should POST status. undefined ⇒ adapter's default route. */
  callbackUrl?: string;
}

export interface CreateFromTemplateInput {
  templateKey: string;
  templateValues: Record<string, unknown>;
  agreementRef: string;
  signers: EsignSigner[];
  expireInDays?: number;
  callbackUrl?: string;
}

export interface CreateSignRequestResult {
  providerDocumentId: string | null;
  customerSigningUrl: string | null;
  raw: Record<string, unknown>;
}

export interface ParsedWebhookStatus {
  /** Correlation ref echoed by the provider (matched first). */
  matchRef: string | null;
  /** Provider document id (fallback match key). */
  providerDocumentId: string | null;
  canonical: CanonicalSignStatus;
  /** Raw provider status string for the audit layer. */
  providerRawStatus: string;
  signedDocumentUrl?: string | null;
  auditTrailUrl?: string | null;
  raw: unknown;
}

export interface FetchSignedResult {
  signedPdfUrl: string | null;
  auditTrailUrl: string | null;
}

export interface TestConnectionResult {
  ok: boolean;
  detail?: string;
}

export interface EsignProvider {
  readonly providerId: string;
  createSignRequestFromPdf(input: CreateFromPdfInput, creds: EsignCreds): Promise<CreateSignRequestResult>;
  createSignRequestFromTemplate?(input: CreateFromTemplateInput, creds: EsignCreds): Promise<CreateSignRequestResult>;
  /** Map a raw provider webhook into the canonical status. Returns null if unrecognised. */
  parseWebhookStatus(
    rawBody: string,
    headers: Record<string, string>,
    creds?: EsignCreds,
  ): Promise<ParsedWebhookStatus | null>;
  fetchSignedDocuments(
    input: { leadId: string; providerDocumentId: string },
    creds: EsignCreds,
  ): Promise<FetchSignedResult>;
  testConnection(creds: EsignCreds): Promise<TestConnectionResult>;
}
