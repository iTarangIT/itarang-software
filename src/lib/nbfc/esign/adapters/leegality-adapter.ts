/**
 * Leegality e-sign adapter (E-166).
 *
 * Auth: `X-Auth-Token: <workspace token>` (the NBFC pastes their token).
 * Base URL by environment: sandbox `https://sandbox.leegality.com/api/`,
 * production `https://app1.leegality.com/api/`.
 *
 * ⚠️ The exact endpoint PATHS and request/response FIELD NAMES below are the
 * single set of unknowns in this feature — confirm them against Leegality's
 * official API docs / Postman collection and adjust the `LEEGALITY_PATHS` +
 * field reads. Everything else (auth, env routing, canonical mapping, storage)
 * is settled. Marked `TODO(leegality)` where confirmation is needed.
 */
import { putNbfcObject } from "@/lib/nbfc/nbfc-storage";
import type {
  CreateFromPdfInput,
  CreateSignRequestResult,
  EsignCreds,
  EsignProvider,
  FetchSignedResult,
  ParsedWebhookStatus,
  TestConnectionResult,
} from "../provider";

const BASE_URLS = {
  sandbox: "https://sandbox.leegality.com/api/",
  production: "https://app1.leegality.com/api/",
} as const;

// TODO(leegality): confirm exact paths from Leegality's Postman collection.
const LEEGALITY_PATHS = {
  createRequest: "v3.0/sign/request",
  documentStatus: "v3.0/sign/request/", // + documentId
  // download endpoints typically accept the document id as a query/path param
};

function baseUrl(creds: EsignCreds): string {
  return creds.baseUrl ?? BASE_URLS[creds.environment] ?? BASE_URLS.sandbox;
}

function authHeaders(creds: EsignCreds): Record<string, string> {
  return {
    "X-Auth-Token": creds.secrets.authToken,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (obj?.[k] != null) return obj[k];
  return undefined;
}

export class LeegalityEsignAdapter implements EsignProvider {
  readonly providerId = "leegality";

  async createSignRequestFromPdf(
    input: CreateFromPdfInput,
    creds: EsignCreds,
  ): Promise<CreateSignRequestResult> {
    // TODO(leegality): confirm body field names (file/invitees/profile) against docs.
    const body = {
      file: { name: input.fileName, file: input.fileData }, // base64
      // Our correlation ref + result callback; Leegality echoes these on webhook.
      reference: input.agreementRef,
      callbackUrl: input.callbackUrl,
      expiryDays: input.expireInDays ?? 14,
      invitees: input.signers.map((s, i) => ({
        name: s.name,
        email: s.identifier.includes("@") ? s.identifier : undefined,
        phone: s.identifier.includes("@") ? undefined : s.identifier,
        sequence: s.sequence ?? i + 1,
      })),
    };
    const res = await fetch(baseUrl(creds) + LEEGALITY_PATHS.createRequest, {
      method: "POST",
      headers: authHeaders(creds),
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`Leegality create request failed (HTTP ${res.status})`);
    }
    const d = ((data.data as Record<string, unknown>) ?? data) as Record<string, unknown>;
    const documentId = (pick(d, "documentId", "id", "requestId") as string) ?? null;
    const invitees = (d.invitees as Array<Record<string, unknown>> | undefined) ?? [];
    const signingUrl =
      (pick(d, "signUrl", "signingUrl") as string) ??
      (invitees[0] ? (pick(invitees[0], "signUrl", "signingUrl") as string) : null) ??
      null;
    return { providerDocumentId: documentId, customerSigningUrl: signingUrl, raw: d };
  }

  async parseWebhookStatus(rawBody: string): Promise<ParsedWebhookStatus | null> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return null;
    }
    // TODO(leegality): confirm webhook field names + status vocabulary.
    const rawStatus = String(pick(body, "status", "documentStatus") ?? "").toLowerCase();
    const canonical =
      rawStatus.includes("sign") || rawStatus.includes("complet")
        ? "signed"
        : rawStatus.includes("expir") || rawStatus.includes("reject") || rawStatus.includes("fail")
          ? "failed"
          : "in_progress";
    return {
      matchRef: (pick(body, "reference", "referenceId") as string) ?? null,
      providerDocumentId: (pick(body, "documentId", "id", "requestId") as string) ?? null,
      canonical,
      providerRawStatus: rawStatus || "unknown",
      signedDocumentUrl: (pick(body, "signedDocumentUrl", "documentUrl") as string) ?? null,
      auditTrailUrl: (pick(body, "auditTrailUrl", "auditUrl") as string) ?? null,
      raw: body,
    };
  }

  async fetchSignedDocuments(
    input: { leadId: string; providerDocumentId: string },
    creds: EsignCreds,
  ): Promise<FetchSignedResult> {
    // TODO(leegality): confirm the signed-doc + audit download endpoints.
    const statusRes = await fetch(
      baseUrl(creds) + LEEGALITY_PATHS.documentStatus + encodeURIComponent(input.providerDocumentId),
      { headers: authHeaders(creds), cache: "no-store" },
    ).catch(() => null);
    if (!statusRes || !statusRes.ok) return { signedPdfUrl: null, auditTrailUrl: null };
    const data = (await statusRes.json().catch(() => ({}))) as Record<string, unknown>;
    const d = ((data.data as Record<string, unknown>) ?? data) as Record<string, unknown>;
    const signedUrl = pick(d, "signedDocumentUrl", "documentUrl") as string | undefined;
    const auditUrl = pick(d, "auditTrailUrl", "auditUrl") as string | undefined;

    const store = async (url: string | undefined, key: string): Promise<string | null> => {
      if (!url) return null;
      const r = await fetch(url, { headers: { "X-Auth-Token": creds.secrets.authToken }, cache: "no-store" }).catch(
        () => null,
      );
      if (!r || !r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.byteLength < 100) return null;
      const { url: stored } = await putNbfcObject(`agreements/${input.leadId}/${key}`, buf, "application/pdf");
      return stored;
    };
    const [signedPdfUrl, auditTrailUrl] = await Promise.all([
      store(signedUrl, "signed.pdf"),
      store(auditUrl, "audit-trail.pdf"),
    ]);
    return { signedPdfUrl, auditTrailUrl };
  }

  async testConnection(creds: EsignCreds): Promise<TestConnectionResult> {
    try {
      const res = await fetch(baseUrl(creds) + LEEGALITY_PATHS.createRequest, {
        method: "GET",
        headers: authHeaders(creds),
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, detail: "Invalid Leegality auth token" };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : "Connection failed" };
    }
  }
}
