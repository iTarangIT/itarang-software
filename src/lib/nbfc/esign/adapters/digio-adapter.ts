/**
 * Digio e-sign adapter (E-166). Wraps the existing Digio integration behind the
 * vendor-neutral EsignProvider port.
 *
 * - `creds.source === "global"` → delegates to the EXISTING functions
 *   (createLoanAgreementSignRequest / createMultiTemplateSignRequest /
 *   fetchSignedLoanAgreementPdfAndAuditTrail) verbatim → ZERO behaviour change
 *   for iTarang's shared Digio account (incl. the AC test stubs).
 * - `creds.source === "tenant"` → an NBFC's OWN Digio keys: a per-call axios
 *   client + the same credless payload builders, posting to the same endpoints,
 *   with notify_url pointed at /api/esign/digio/webhook.
 */
import axios, { type AxiosInstance } from "axios";

import {
  DIGIO_PRODUCTION_BASE_URL,
  DIGIO_SANDBOX_BASE_URL,
  basicAuthHeader,
} from "@/lib/digio/client";
import {
  buildLoanAgreementUploadPayload,
  type LoanAgreementUploadInput,
} from "@/lib/digio/loan-agreement-mapper";
import { createLoanAgreementSignRequest } from "@/lib/digio/service";
import {
  DIGIO_MULTI_TEMPLATE_CREATE_SIGN_REQUEST_PATH,
  createMultiTemplateSignRequest,
  type MultiTemplateCreateInput,
} from "@/lib/digio/multi-templates";
import type { DigioSigner } from "@/lib/digio/mapper";
import { fetchSignedLoanAgreementPdfAndAuditTrail } from "@/lib/nbfc/fetchSignedAgreementPdf";
import type {
  CreateFromPdfInput,
  CreateFromTemplateInput,
  CreateSignRequestResult,
  EsignCreds,
  EsignProvider,
  EsignSigner,
  FetchSignedResult,
  ParsedWebhookStatus,
  TestConnectionResult,
} from "../provider";

function baseUrlFor(creds: EsignCreds): string {
  if (creds.baseUrl) return creds.baseUrl;
  return creds.environment === "production" ? DIGIO_PRODUCTION_BASE_URL : DIGIO_SANDBOX_BASE_URL;
}

function tenantClient(creds: EsignCreds): AxiosInstance {
  return axios.create({
    baseURL: baseUrlFor(creds),
    auth: { username: creds.secrets.clientId, password: creds.secrets.clientSecret },
    headers: { "Content-Type": "application/json" },
  });
}

function toDigioSigners(signers: EsignSigner[]): DigioSigner[] {
  return signers.map((s) => ({
    identifier: s.identifier,
    name: s.name,
    reason: s.reason,
    sign_type: s.signType ?? "aadhaar",
    sign_coordinates: s.signCoordinates
      ? {
          page_no: s.signCoordinates.page,
          x: s.signCoordinates.x,
          y: s.signCoordinates.y,
          w: s.signCoordinates.w,
          h: s.signCoordinates.h,
        }
      : undefined,
  }));
}

function extractResult(data: unknown): CreateSignRequestResult {
  const d = (data ?? {}) as Record<string, unknown>;
  const id = (d.id as string) ?? (d.document_id as string) ?? null;
  const parties = (d.signing_parties as Array<Record<string, unknown>> | undefined) ?? [];
  const first = parties[0] ?? {};
  const url =
    (first.authentication_url as string) ?? (first.authenticationUrl as string) ?? null;
  return { providerDocumentId: id, customerSigningUrl: url, raw: d };
}

export class DigioEsignAdapter implements EsignProvider {
  readonly providerId = "digio";

  async createSignRequestFromPdf(
    input: CreateFromPdfInput,
    creds: EsignCreds,
  ): Promise<CreateSignRequestResult> {
    const data: LoanAgreementUploadInput = {
      fileData: input.fileData,
      fileName: input.fileName,
      agreementRef: input.agreementRef,
      signers: toDigioSigners(input.signers),
      expireInDays: input.expireInDays,
    };
    if (creds.source === "global") {
      // Untouched global path (keeps default notify_url + AC behaviour).
      return extractResult(await createLoanAgreementSignRequest(data));
    }
    const payload = buildLoanAgreementUploadPayload(
      data,
      input.callbackUrl ? { notifyUrl: input.callbackUrl } : undefined,
    );
    const resp = await tenantClient(creds).post("/v2/client/document/uploadpdf", payload);
    return extractResult(resp.data);
  }

  async createSignRequestFromTemplate(
    input: CreateFromTemplateInput,
    creds: EsignCreds,
  ): Promise<CreateSignRequestResult> {
    const payload: MultiTemplateCreateInput = {
      templates: [{ template_key: input.templateKey, template_values: input.templateValues }],
      signers: input.signers.map((s) => ({
        identifier: s.identifier,
        name: s.name,
        reason: s.reason,
        sign_type: s.signType ?? "aadhaar",
      })),
      expire_in_days: input.expireInDays ?? 14,
      notify_signers: true,
      send_sign_link: true,
      generate_access_token: true,
      sequence_type: "SEQUENTIAL",
      callback: `AGR_${input.agreementRef}`,
    };
    if (creds.source === "global") {
      return extractResult(await createMultiTemplateSignRequest(payload));
    }
    const resp = await tenantClient(creds).post(DIGIO_MULTI_TEMPLATE_CREATE_SIGN_REQUEST_PATH, payload);
    return extractResult(resp.data);
  }

  async parseWebhookStatus(rawBody: string): Promise<ParsedWebhookStatus | null> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return null;
    }
    const p = ((body.payload as Record<string, unknown>) ?? body) as Record<string, unknown>;
    const rawStatus = String(p.agreement_status ?? "").toUpperCase();
    const canonical =
      rawStatus === "COMPLETED" || rawStatus === "SIGNED"
        ? "signed"
        : rawStatus === "FAILED" || rawStatus === "EXPIRED"
          ? "failed"
          : "in_progress";
    const cb = String(p.callback ?? "");
    const matchRef = cb.startsWith("AGR_") ? cb.slice(4) : null;
    return {
      matchRef,
      providerDocumentId: (p.agreement_id as string) ?? (p.id as string) ?? null,
      canonical,
      providerRawStatus: rawStatus || "unknown",
      signedDocumentUrl: (p.signed_document_url as string) ?? null,
      auditTrailUrl: (p.audit_trail_url as string) ?? null,
      raw: body,
    };
  }

  async fetchSignedDocuments(
    input: { leadId: string; providerDocumentId: string },
    creds: EsignCreds,
  ): Promise<FetchSignedResult> {
    const override =
      creds.source === "tenant"
        ? {
            baseUrl: baseUrlFor(creds),
            authHeader: basicAuthHeader(creds.secrets.clientId, creds.secrets.clientSecret),
          }
        : undefined;
    const res = await fetchSignedLoanAgreementPdfAndAuditTrail({
      leadId: input.leadId,
      digioDocumentId: input.providerDocumentId,
      override,
    });
    return { signedPdfUrl: res.signedPdfUrl, auditTrailUrl: res.auditTrailUrl };
  }

  async testConnection(creds: EsignCreds): Promise<TestConnectionResult> {
    try {
      // Authenticated probe: a bogus doc id. 401/403 ⇒ bad creds; anything else
      // (404/200) ⇒ auth accepted.
      await tenantClient(creds).get("/v2/client/document/itarang-cred-probe");
      return { ok: true };
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 401 || status === 403) return { ok: false, detail: "Invalid Digio credentials" };
      if (status) return { ok: true }; // reachable + authorised (e.g. 404 for the bogus id)
      return { ok: false, detail: e instanceof Error ? e.message : "Connection failed" };
    }
  }
}
