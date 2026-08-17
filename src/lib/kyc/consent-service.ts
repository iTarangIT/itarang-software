// Customer KYC consent — shared core, session-agnostic.
//
// Extracted from the three KYC consent route handlers so BOTH the web dealer
// portal (which has a Supabase session) and the WhatsApp chatbot (which does
// NOT) drive the exact same consent logic — Digio e-sign, consent_records
// state, applicant-level status sync and the admin KYC queue. The route
// handlers are now thin wrappers that authenticate, then delegate here.
//
//   sendConsentForLead     → SMS / WhatsApp Digio e-sign (digital)
//   generateManualConsentPdf → print-and-sign PDF (manual)
//   storeSignedConsent     → persist a manually-signed PDF
//   renderConsentPreviewPdf → render the unsigned PDF WITHOUT any DB write
//
// See the originating routes for the inline rationale on idempotency, the
// duplicate-record guard, and the admin-queue chicken-and-egg.

import { and, desc, eq, isNull } from "drizzle-orm";
import crypto from "crypto";

import { db } from "@/lib/db";
import {
  coBorrowers,
  consentOtpVerifications,
  consentRecords,
  kycVerifications,
  leads,
} from "@/lib/db/schema";
import { generateConsentHtml } from "@/lib/consent/consent-pdf-template";
import { sendEmail } from "@/lib/email/mailer";
import { sendMsg91Otp } from "@/lib/msg91";
import { sendTwoFactorVoiceOtp, twoFactorConfigured } from "@/lib/twofactor";
import {
  maskCalcPhone,
  metaWhatsAppConfigured,
  normalizeCalcPhone,
  sendCalcOtpWhatsApp,
} from "@/lib/calculator/whatsapp";
import {
  createDigioAgreement,
  downloadDigioSignedDocument,
  getDigioDocumentStatus,
} from "@/lib/digio/service";
import { fetchAndStoreSignedConsent } from "@/lib/digio/fetch-signed-consent";
import { getConsentSignerIdentity } from "@/lib/digio/signer-aadhaar";
import {
  aadhaarMismatchMessage,
  checkAadhaarMatch,
  getExpectedConsentAadhaar,
} from "@/lib/digio/aadhaar-match";
import { createWorkflowId } from "@/lib/kyc/admin-workflow";
import { ensureAdminKycQueueEntry } from "@/lib/kyc/admin-workflow";
import { stampConsentAutoVerifyDeadline } from "@/lib/kyc/auto-approval";
import { launchBrowser } from "@/lib/pdf/launch-browser";
import { uploadFileToStorage } from "@/lib/storage";
import {
  isS3Backend,
  putObject,
  filesProxyPath,
} from "@/lib/storage/s3";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

export type ConsentFor = "customer" | "borrower";
type ConsentRole = "primary" | "co_borrower";

function toRole(consentFor: ConsentFor | string | undefined): ConsentRole {
  const v = String(consentFor || "customer").toLowerCase();
  return v === "borrower" || v === "co_borrower" ? "co_borrower" : "primary";
}

/** Render a consent HTML document to a PDF buffer (pooled browser, page closed). */
async function renderPdfFromHtml(html: string): Promise<Buffer> {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
  }
}

function formatDob(value: unknown): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value as string);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

function newConsentId(now: Date): string {
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
  return `CONSENT-${dateStr}-${seq}`;
}

interface Signer {
  name: string;
  phone: string | null;
  email: string;
  fatherName: string;
  dob: unknown;
  currentAddress: string;
  permanentAddress: string;
  aadhaar: string;
  pan: string;
}

type LeadRow = typeof leads.$inferSelect;

/** Resolve the signer fields for a lead + applicant role. Returns null if the
 *  lead (or the co-borrower row, for co_borrower) is missing. */
async function resolveSigner(
  leadId: string,
  role: ConsentRole,
): Promise<{ lead: LeadRow; signer: Signer } | null> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) return null;

  if (role === "co_borrower") {
    const [cob] = await db
      .select()
      .from(coBorrowers)
      .where(eq(coBorrowers.lead_id, leadId))
      .limit(1);
    if (!cob) return null;
    return {
      lead,
      signer: {
        name: cob.full_name || "Co-borrower",
        phone: cob.phone || null,
        email: "",
        fatherName: cob.father_or_husband_name || "",
        dob: cob.dob,
        currentAddress: cob.current_address || cob.address || "",
        permanentAddress: cob.permanent_address || cob.address || "",
        aadhaar: cob.aadhaar_no || "",
        pan: cob.pan_no || "",
      },
    };
  }

  return {
    lead,
    signer: {
      name: lead.full_name || lead.owner_name || "Customer",
      phone: lead.phone || lead.owner_contact || null,
      email: lead.owner_email || "",
      fatherName: lead.father_or_husband_name || "",
      dob: lead.dob,
      currentAddress: lead.current_address || "",
      permanentAddress: lead.permanent_address || lead.current_address || "",
      aadhaar: "",
      pan: "",
    },
  };
}

function buildHtml(
  lead: LeadRow,
  signer: Signer,
  consentId: string,
  dealerName: string,
  now: Date,
): string {
  return generateConsentHtml({
    customerName: signer.name,
    fatherOrHusbandName: signer.fatherName,
    dob: formatDob(signer.dob),
    phone: signer.phone || "",
    customerEmail: signer.email,
    currentAddress: signer.currentAddress,
    permanentAddress: signer.permanentAddress,
    aadhaarMasked: signer.aadhaar,
    panNumber: signer.pan,
    productName: lead.asset_model || "",
    productCategory: lead.asset_model || "",
    paymentMethod: lead.payment_method || "",
    dealerName,
    dealerCompany: "",
    leadId: lead.id,
    consentId,
    generatedDate: `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()}`,
    // BRD Addendum V0.1 §3.1 — biometric + multi-NBFC clauses + Page 3, gated by
    // CONSENT_V2_ENABLED until legal sign-off.
    includeBiometricVKYCConsent: process.env.CONSENT_V2_ENABLED === "1",
  });
}

async function syncApplicantStatus(
  role: ConsentRole,
  leadId: string,
  status: string,
  now: Date,
): Promise<void> {
  if (role === "co_borrower") {
    await db
      .update(coBorrowers)
      .set({ consent_status: status, updated_at: now })
      .where(eq(coBorrowers.lead_id, leadId));
    await db
      .update(leads)
      .set({ borrower_consent_status: status, updated_at: now })
      .where(eq(leads.id, leadId));
  } else {
    await db
      .update(leads)
      .set({ consent_status: status, updated_at: now })
      .where(eq(leads.id, leadId));
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export type SendConsentResult =
  | {
      ok: true;
      alreadyActive: boolean;
      replaced: boolean;
      consentId: string;
      channel: string;
      phone: string;
      customerSigningUrl: string | null;
      digioDocumentId: string | null;
      sentAt: string;
    }
  | { ok: false; status: number; error: string };

/**
 * Send a customer consent for e-signing over SMS or WhatsApp via Digio.
 * Idempotent: an already-active consent is returned as-is; a failed/expired one
 * is refreshed in place; otherwise a new record is inserted.
 */
export async function sendConsentForLead(opts: {
  leadId: string;
  channel: "sms" | "whatsapp" | "email";
  consentFor?: ConsentFor;
  dealerName?: string;
  // NBFC Acquire "run consent yourself" flow: sign THIS document (the NBFC's own
  // uploaded consent template) instead of the per-lead iTarang-generated PDF. When
  // omitted, the default dealer/admin behaviour is unchanged.
  documentOverride?: { pdfBase64: string; fileName: string; url: string };
  // Stamp the consent_records row with the acting NBFC tenant (Req 1 — the NBFC
  // only sees its own consent). NULL/omitted ⇒ iTarang/dealer-captured.
  initiatedByTenantId?: string;
}): Promise<SendConsentResult> {
  const role = toRole(opts.consentFor);
  const resolved = await resolveSigner(opts.leadId, role);
  if (!resolved) {
    return { ok: false, status: 404, error: "Lead or co-borrower not found" };
  }
  const { lead, signer } = resolved;
  if (!signer.phone) {
    return {
      ok: false,
      status: 400,
      error:
        role === "co_borrower"
          ? "Co-borrower phone number not available"
          : "Customer phone number not available",
    };
  }
  // The e-sign link can also be delivered by email — requires an address on file.
  if (opts.channel === "email" && !signer.email) {
    return {
      ok: false,
      status: 400,
      error:
        role === "co_borrower"
          ? "Co-borrower email address not available"
          : "Customer email address not available",
    };
  }

  // Idempotency: reuse an active record; refresh a failed/expired one.
  const existing = await db
    .select()
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.lead_id, opts.leadId),
        eq(consentRecords.consent_for, role),
      ),
    );

  const ACTIVE = new Set(["link_sent", "viewed", "signed", "esign_completed"]);
  const active = existing.find((r) => ACTIVE.has(r.consent_status || ""));
  if (active) {
    return {
      ok: true,
      alreadyActive: true,
      replaced: false,
      consentId: active.id,
      channel: active.consent_delivery_channel || opts.channel,
      phone: signer.phone.replace(/\D/g, "").slice(-10),
      customerSigningUrl: active.consent_link_url ?? null,
      digioDocumentId: active.esign_transaction_id ?? null,
      sentAt: active.consent_link_sent_at?.toISOString() ?? new Date().toISOString(),
    };
  }

  // NOTE: no pre-send Aadhaar gate. Dealers can send the consent e-sign link
  // without the applicant's Aadhaar on file. The signer-Aadhaar integrity check
  // still runs at signing time (webhook + status-poll below), but it is
  // best-effort — checkAadhaarMatch() treats a missing expected Aadhaar as
  // "not comparable" and lets the e-sign complete rather than blocking.
  // Refreshable = any terminal-but-not-active state, including the Aadhaar
  // mismatch outcomes (esign_failed / esign_blocked) and an admin rejection — so
  // "Regenerate Consent" after a mismatch re-issues a fresh link in place.
  const REFRESHABLE = new Set([
    "failed",
    "expired",
    "rejected",
    "esign_failed",
    "esign_blocked",
    "admin_rejected",
  ]);
  const refreshable = existing
    .filter((r) => REFRESHABLE.has(r.consent_status || ""))
    .sort(
      (a, b) =>
        (b.updated_at?.getTime?.() ?? 0) - (a.updated_at?.getTime?.() ?? 0),
    )[0];

  const now = new Date();
  const consentId = newConsentId(now);
  const override = opts.documentOverride;
  // Default flow renders the per-lead iTarang consent PDF; the NBFC flow signs
  // the NBFC's own uploaded template as-is.
  const pdfBase64 = override
    ? override.pdfBase64
    : await renderPdfFromHtml(
        buildHtml(lead, signer, consentId, opts.dealerName || "", now),
      ).then((buf) => buf.toString("base64"));
  const cleanPhone = signer.phone.replace(/\D/g, "").slice(-10);

  // Unsigned-PDF storage + Digio agreement run in parallel (both network-bound).
  // For the NBFC override we already have a stored template URL — reuse it.
  const bucket = (process.env.CONSENT_STORAGE_BUCKET || "documents").trim();
  const storagePath = `kyc/${opts.leadId}/consent/unsigned-${Date.now()}.pdf`;
  const storageUploadPromise: Promise<string | null> = override
    ? Promise.resolve(override.url)
    : (async () => {
        try {
          const pdfBuffer = Buffer.from(pdfBase64, "base64");
          if (isS3Backend) {
            await putObject(bucket, storagePath, pdfBuffer, "application/pdf");
            return filesProxyPath(bucket, storagePath);
          }
          const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
          const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
          if (!supabaseUrl || !serviceRoleKey) return null;
          const supabase = createSupabaseClient(supabaseUrl, serviceRoleKey);
          const { error } = await supabase.storage
            .from(bucket)
            .upload(storagePath, pdfBuffer, {
              contentType: "application/pdf",
              upsert: true,
            });
          if (error) return null;
          const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
          return data?.publicUrl || null;
        } catch (e) {
          console.warn("[consent-service] unsigned PDF storage error:", e);
          return null;
        }
      })();

  const digioPromise = createDigioAgreement({
    fileData: pdfBase64,
    fileName: override?.fileName ?? `consent_${opts.leadId}_${consentId}.pdf`,
    signers: [
      {
        identifier: cleanPhone,
        name: signer.name,
        reason:
          role === "co_borrower"
            ? "Co-borrower Consent for KYC & Loan Processing"
            : "Customer Consent for KYC & Loan Processing",
        sign_type: "aadhaar",
      },
    ],
    expireInDays: 1,
    sequential: false,
  });

  const [generatedPdfUrl, digioResponse] = await Promise.all([
    storageUploadPromise,
    digioPromise,
  ]);

  const digioDocumentId =
    (digioResponse as any)?.id || (digioResponse as any)?.document_id || null;
  const signingParties = (digioResponse as any)?.signing_parties || [];
  const customerSigningUrl =
    signingParties[0]?.authentication_url ||
    signingParties[0]?.authenticationUrl ||
    null;

  if (!digioDocumentId) {
    return {
      ok: false,
      status: 500,
      error:
        "Failed to create consent document with eSign provider. Check DigiO credentials.",
    };
  }

  const finalConsentId = refreshable?.id || consentId;
  if (refreshable) {
    await db
      .update(consentRecords)
      .set({
        consent_status: "link_sent",
        consent_delivery_channel: opts.channel,
        consent_link_url: customerSigningUrl,
        consent_link_sent_at: now,
        esign_transaction_id: digioDocumentId,
        generated_pdf_url: generatedPdfUrl,
        // Fresh start: clear the previous signer + mismatch outcome and reset the
        // retry ladder so a regenerated consent gets a clean set of attempts.
        signer_aadhaar_masked: null,
        signer_name_match_score: null,
        esign_retry_count: 0,
        esign_error_message: null,
        signed_at: null,
        signed_consent_url: null,
        verified_by: null,
        verified_at: null,
        rejected_by: null,
        rejected_at: null,
        initiated_by_tenant_id: opts.initiatedByTenantId ?? null,
        updated_at: now,
      })
      .where(eq(consentRecords.id, refreshable.id));
  } else {
    await db.insert(consentRecords).values({
      id: consentId,
      lead_id: opts.leadId,
      consent_for: role,
      consent_type: "digital",
      consent_status: "link_sent",
      consent_delivery_channel: opts.channel,
      consent_link_url: customerSigningUrl,
      consent_link_sent_at: now,
      esign_transaction_id: digioDocumentId,
      generated_pdf_url: generatedPdfUrl,
      initiated_by_tenant_id: opts.initiatedByTenantId ?? null,
      created_at: now,
      updated_at: now,
    });
  }

  // Audit (non-fatal) — upsert by (lead, esign_consent, applicant).
  try {
    const [existingAudit] = await db
      .select({ id: kycVerifications.id })
      .from(kycVerifications)
      .where(
        and(
          eq(kycVerifications.lead_id, opts.leadId),
          eq(kycVerifications.verification_type, "esign_consent"),
          eq(kycVerifications.applicant, role),
        ),
      )
      .limit(1);
    const auditValues = {
      status: "success",
      api_provider: "digio",
      api_request: { consent_id: finalConsentId, channel: opts.channel, phone: cleanPhone },
      api_response: digioResponse as unknown as Record<string, unknown>,
      completed_at: now,
      updated_at: now,
    };
    if (existingAudit) {
      await db.update(kycVerifications).set(auditValues).where(eq(kycVerifications.id, existingAudit.id));
    } else {
      await db.insert(kycVerifications).values({
        id: createWorkflowId("KYCVER", now),
        lead_id: opts.leadId,
        verification_type: "esign_consent",
        applicant: role,
        submitted_at: now,
        ...auditValues,
      });
    }
  } catch (persistErr) {
    console.error("[consent-service] kyc_verifications upsert failed:", persistErr);
  }

  await syncApplicantStatus(role, opts.leadId, "link_sent", now);

  // Email delivery of the signing link (best-effort — never blocks the send).
  if (opts.channel === "email" && signer.email && customerSigningUrl) {
    try {
      await sendEmail({
        to: signer.email,
        subject: "[iTarang] Please sign your consent document",
        text: `Dear ${signer.name},\n\nPlease review and sign your consent document using the secure link below:\n\n${customerSigningUrl}\n\nThank you,\niTarang`,
        html: `<p>Dear ${signer.name},</p><p>Please review and sign your consent document using the secure link below:</p><p><a href="${customerSigningUrl}">Review &amp; sign your consent →</a></p><p>Thank you,<br/>iTarang</p>`,
      });
    } catch (e) {
      console.error("[consent-service] e-sign email delivery failed:", e);
    }
  }

  return {
    ok: true,
    alreadyActive: false,
    replaced: !!refreshable,
    consentId: finalConsentId,
    channel: opts.channel,
    phone: cleanPhone,
    customerSigningUrl,
    digioDocumentId,
    sentAt: now.toISOString(),
  };
}

export type GenerateManualResult =
  | {
      ok: true;
      consentId: string;
      pdfUrl: string;
      fileName: string;
      generatedAt: string;
      /** The rendered PDF bytes — so callers can send by upload (WhatsApp) when
       *  pdfUrl isn't a publicly-reachable URL. */
      pdfBuffer: Buffer;
    }
  | { ok: false; status: number; error: string };

/** Generate the print-and-sign consent PDF (manual path) and persist a
 *  consent_records row in 'consent_generated' status. */
export async function generateManualConsentPdf(opts: {
  leadId: string;
  consentFor?: ConsentFor;
  dealerName?: string;
}): Promise<GenerateManualResult> {
  const role = toRole(opts.consentFor);
  const resolved = await resolveSigner(opts.leadId, role);
  if (!resolved) {
    return { ok: false, status: 404, error: "Lead or co-borrower not found" };
  }
  const { lead, signer } = resolved;

  const now = new Date();
  const consentId = newConsentId(now);
  const html = buildHtml(lead, signer, consentId, opts.dealerName || "", now);
  const pdfBuffer = await renderPdfFromHtml(html);

  const fileName = `consent_${consentId}_${Date.now()}.pdf`;
  const uploadResult = await uploadFileToStorage({
    fileBuffer: pdfBuffer,
    fileName,
    folder: `kyc/${opts.leadId}/consent`,
    contentType: "application/pdf",
  });

  await db.insert(consentRecords).values({
    id: consentId,
    lead_id: opts.leadId,
    consent_for: role,
    consent_type: "manual",
    consent_status: "consent_generated",
    generated_pdf_url: uploadResult.url,
    created_at: now,
    updated_at: now,
  });
  await syncApplicantStatus(role, opts.leadId, "consent_generated", now);

  return {
    ok: true,
    consentId,
    pdfUrl: uploadResult.url,
    fileName,
    generatedAt: now.toISOString(),
    pdfBuffer,
  };
}

export type StoreSignedResult =
  | { ok: true; fileUrl: string }
  | { ok: false; status: number; error: string };

/** Persist a manually-signed consent PDF (buffer) and surface the lead to the
 *  admin KYC review queue. Updates the existing consent_records row if present. */
export async function storeSignedConsent(opts: {
  leadId: string;
  buffer: Buffer;
  consentFor?: ConsentFor;
}): Promise<StoreSignedResult> {
  const role = toRole(opts.consentFor);
  const now = new Date();
  const fileName = `kyc/${opts.leadId}/signed_consent_${Date.now()}.pdf`;

  let signedConsentUrl: string;
  try {
    if (isS3Backend) {
      await putObject("documents", fileName, opts.buffer, "application/pdf");
      signedConsentUrl = filesProxyPath("documents", fileName);
    } else {
      const uploaded = await uploadFileToStorage({
        fileBuffer: opts.buffer,
        fileName: `signed_consent_${Date.now()}.pdf`,
        folder: `kyc/${opts.leadId}`,
        contentType: "application/pdf",
      });
      signedConsentUrl = uploaded.url;
    }
  } catch (e) {
    console.error("[consent-service] signed PDF upload failed:", e);
    return { ok: false, status: 500, error: "Upload failed" };
  }

  const [existing] = await db
    .select({ id: consentRecords.id })
    .from(consentRecords)
    .where(and(eq(consentRecords.lead_id, opts.leadId), eq(consentRecords.consent_for, role)))
    .orderBy(desc(consentRecords.created_at))
    .limit(1);

  if (existing) {
    await db
      .update(consentRecords)
      .set({
        consent_type: "manual",
        consent_status: "admin_review_pending",
        signed_consent_url: signedConsentUrl,
        signed_at: now,
        updated_at: now,
      })
      .where(eq(consentRecords.id, existing.id));
  } else {
    await db.insert(consentRecords).values({
      id: newConsentId(now),
      lead_id: opts.leadId,
      consent_for: role,
      consent_type: "manual",
      consent_status: "admin_review_pending",
      signed_consent_url: signedConsentUrl,
      signed_at: now,
      created_at: now,
      updated_at: now,
    });
  }

  await syncApplicantStatus(role, opts.leadId, "admin_review_pending", now);
  await ensureAdminKycQueueEntry(opts.leadId);

  // E-243 — the customer has signed, so start the auto-verify clock. The sweep
  // verifies it once the window closes, which leaves the admin time to reject.
  // Fire-and-forget: a consent that saved must never fail because the
  // automation did. Without this stamp the sweep can never see the record.
  stampConsentAutoVerifyDeadline(opts.leadId).catch(() => {});

  return { ok: true, fileUrl: signedConsentUrl };
}

/** Render the unsigned consent PDF for preview WITHOUT writing any DB row or
 *  creating a Digio agreement. Returns the buffer + a public URL (uploaded to a
 *  preview path). Used by the WhatsApp bot to show the dealer the form before
 *  they pick a delivery channel. */
export async function renderConsentPreviewPdf(opts: {
  leadId: string;
  consentFor?: ConsentFor;
  dealerName?: string;
}): Promise<
  { ok: true; url: string; pdfBuffer: Buffer } | { ok: false; error: string }
> {
  const role = toRole(opts.consentFor);
  const resolved = await resolveSigner(opts.leadId, role);
  if (!resolved) return { ok: false, error: "Lead not found" };
  const now = new Date();
  const html = buildHtml(
    resolved.lead,
    resolved.signer,
    newConsentId(now),
    opts.dealerName || "",
    now,
  );
  const pdfBuffer = await renderPdfFromHtml(html);
  try {
    const uploaded = await uploadFileToStorage({
      fileBuffer: pdfBuffer,
      fileName: `consent_preview_${Date.now()}.pdf`,
      folder: `kyc/${opts.leadId}/consent/preview`,
      contentType: "application/pdf",
    });
    return { ok: true, url: uploaded.url, pdfBuffer };
  } catch (e) {
    console.error("[consent-service] preview upload failed:", e);
    return { ok: false, error: "Failed to render consent preview" };
  }
}

// ── OTP-based consent (E-180) ────────────────────────────────────────────────
//
// Replaces Digio Aadhaar e-sign as the active consent mechanism (gated by
// CONSENT_OTP_ENABLED at the route/orchestrator layer). The customer receives a
// 6-digit OTP (SMS via MSG91 / WhatsApp via Meta) and consent is recorded once
// the OTP is verified. Mechanics mirror the Step 5 dispatch OTP + calculator OTP
// gate verbatim: SHA-256 hash, 10-min expiry, 3 sends / 30-min cooldown, 3
// attempts / 5-min lock. Unlike Digio, a verified OTP AUTO-COMPLETES the consent
// (consent_status='verified') — no admin consent-review step (mirrors exactly
// what admin/kyc/.../consent/.../verify writes). It does NOT touch
// kyc_status/final_decision, so the separate admin KYC decision gating Step 4 is
// unchanged. OTP consents carry no Aadhaar, so the E-175/E-176 signer-match gate
// never applies (getSignedConsentForLead skips it when esign_transaction_id is null).

const OTP_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_SENDS = 3;
const OTP_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes after max sends
const OTP_MAX_ATTEMPTS = 3;
const OTP_LOCK_MS = 5 * 60 * 1000; // 5 minutes

function hashOtp(otp: string): string {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

function smsOtpConfigured(): boolean {
  return !!(
    (process.env.MSG91_AUTH_KEY?.trim()?.length ?? 0) > 5 &&
    (process.env.MSG91_TEMPLATE_ID?.trim()?.length ?? 0) > 5
  );
}

/** OTP delivery channel. 'call' = 2Factor automated voice call (primary);
 *  'whatsapp' = Meta (currently "coming soon" in the UI); 'sms' = MSG91 (legacy);
 *  'email' = transactional email via the shared mailer. */
export type ConsentOtpChannel = "call" | "sms" | "whatsapp" | "email";

export type SendConsentOtpResult =
  | {
      ok: true;
      consentId: string;
      consentFor: ConsentRole;
      channel: ConsentOtpChannel;
      phone: string;
      otpSentTo: string;
      previewUrl: string | null;
      /** Rendered consent PDF bytes — so the WhatsApp caller can send by upload. */
      pdfBuffer: Buffer | null;
      expiresInSeconds: number;
      sendCount: number;
      maxSends: number;
      deliveryStatus: "sent" | "dev_hardcoded" | "failed";
      /** Present only in dev / hardcoded mode so the flow is testable end-to-end. */
      devOtp?: string;
    }
  | { ok: false; status: number; error: string };

/**
 * Send an OTP to capture customer (or co-borrower) consent. Renders + stores the
 * consent PDF so the customer can see what they're consenting to, generates a
 * 6-digit OTP, delivers it over the chosen channel, and flips the consent_records
 * row to 'otp_sent'. Idempotent per (lead, consent_for): reuses the open OTP
 * session (bumping send_count) until the cooldown, then starts fresh.
 */
export async function sendConsentOtp(opts: {
  leadId: string;
  channel: ConsentOtpChannel;
  consentFor?: ConsentFor;
  dealerName?: string;
  requestedBy?: string | null;
  // NBFC Acquire flow: show/consent to the NBFC's own uploaded template instead
  // of the per-lead iTarang preview PDF. Omitted ⇒ default behaviour unchanged.
  documentOverride?: { pdfBase64: string; fileName: string; url: string };
  // Stamp the consent_records row with the acting NBFC tenant (Req 1).
  initiatedByTenantId?: string;
}): Promise<SendConsentOtpResult> {
  const role = toRole(opts.consentFor);
  const channel: ConsentOtpChannel =
    opts.channel === "whatsapp"
      ? "whatsapp"
      : opts.channel === "sms"
        ? "sms"
        : opts.channel === "email"
          ? "email"
          : "call";

  const resolved = await resolveSigner(opts.leadId, role);
  if (!resolved) {
    return { ok: false, status: 404, error: "Lead or co-borrower not found" };
  }
  const { signer } = resolved;
  // Email OTP needs an address on file; every other channel needs a phone.
  if (channel === "email" && !signer.email) {
    return {
      ok: false,
      status: 400,
      error:
        role === "co_borrower"
          ? "Co-borrower email address not available"
          : "Customer email address not available",
    };
  }
  if (channel !== "email" && !signer.phone) {
    return {
      ok: false,
      status: 400,
      error:
        role === "co_borrower"
          ? "Co-borrower phone number not available"
          : "Customer phone number not available",
    };
  }

  const tenDigit = (signer.phone ?? "").replace(/\D/g, "").slice(-10);
  const normalized = signer.phone ? normalizeCalcPhone(signer.phone) : null; // "91XXXXXXXXXX" or null
  const storedPhone = normalized || tenDigit || signer.email;
  const maskedEmail =
    signer.email.length > 0
      ? `${signer.email.slice(0, 2)}***@${signer.email.split("@")[1] ?? ""}`
      : "";
  const masked =
    channel === "email"
      ? maskedEmail
      : normalized
        ? maskCalcPhone(normalized)
        : `XXXXXX${tenDigit.slice(-4)}`;

  // Latest open OTP session for (lead, consent_for) — reused (send_count bumped)
  // until OTP_MAX_SENDS, then a cooldown before a fresh session is allowed.
  const [existingSession] = await db
    .select()
    .from(consentOtpVerifications)
    .where(
      and(
        eq(consentOtpVerifications.leadId, opts.leadId),
        eq(consentOtpVerifications.consentFor, role),
        isNull(consentOtpVerifications.verifiedAt),
        isNull(consentOtpVerifications.consumedAt),
      ),
    )
    .orderBy(desc(consentOtpVerifications.createdAt))
    .limit(1);

  const now = new Date();
  let session = existingSession;
  if (session && session.sendCount >= OTP_MAX_SENDS) {
    const cutoff = new Date(session.createdAt.getTime() + OTP_COOLDOWN_MS);
    if (now < cutoff) {
      const waitMins = Math.ceil((cutoff.getTime() - now.getTime()) / 60000);
      return {
        ok: false,
        status: 429,
        error: `Max OTP resends reached. Please wait ${waitMins} min before trying again.`,
      };
    }
    await db
      .update(consentOtpVerifications)
      .set({ consumedAt: now })
      .where(eq(consentOtpVerifications.id, session.id));
    session = undefined;
  }

  // Render + store the consent PDF (best-effort — never blocks the OTP). For the
  // NBFC flow the document is the NBFC's own uploaded template, already stored.
  let previewUrl: string | null = null;
  let pdfBuffer: Buffer | null = null;
  if (opts.documentOverride) {
    previewUrl = opts.documentOverride.url;
    pdfBuffer = Buffer.from(opts.documentOverride.pdfBase64, "base64");
  } else {
    const preview = await renderConsentPreviewPdf({
      leadId: opts.leadId,
      consentFor: opts.consentFor,
      dealerName: opts.dealerName,
    });
    if (preview.ok) {
      previewUrl = preview.url;
      pdfBuffer = preview.pdfBuffer;
    }
  }

  // Dev shortcut mirrors Step 5 / calculator: without live provider creds we use
  // a hardcoded OTP so the flow is testable; verification still hash-compares
  // through the exact production path.
  const configured =
    channel === "email"
      ? true // mailer is always available; failures surface at delivery below
      : channel === "whatsapp"
        ? metaWhatsAppConfigured()
        : channel === "sms"
          ? smsOtpConfigured()
          : twoFactorConfigured();
  const otp = configured
    ? Math.floor(100000 + Math.random() * 900000).toString()
    : "123456";
  const otpHash = hashOtp(otp);
  const expiresAt = new Date(now.getTime() + OTP_LIFETIME_MS);

  let deliveryStatus: "sent" | "dev_hardcoded" | "failed" = "dev_hardcoded";
  if (configured) {
    const delivered =
      channel === "email"
        ? await (async () => {
            try {
              await sendEmail({
                to: signer.email,
                subject: "[iTarang] Your consent OTP",
                text: `Dear ${signer.name},\n\nYour consent OTP is ${otp}. It is valid for 10 minutes.\n\nIf you did not request this, please ignore this email.\n\nThank you,\niTarang`,
                html: `<p>Dear ${signer.name},</p><p>Your consent OTP is <strong style="font-size:18px;letter-spacing:2px">${otp}</strong>. It is valid for 10 minutes.</p><p>If you did not request this, please ignore this email.</p><p>Thank you,<br/>iTarang</p>`,
              });
              return true;
            } catch (e) {
              console.error("[consent-service] email OTP delivery failed:", e);
              return false;
            }
          })()
        : channel === "whatsapp"
          ? (await sendCalcOtpWhatsApp(normalized || `91${tenDigit}`, otp, signer.name)).ok
          : channel === "sms"
            ? (await sendMsg91Otp({ mobile_number: signer.phone!, otp, otp_expiry_minutes: 10 })).success
            : (await sendTwoFactorVoiceOtp({ mobile_number: signer.phone!, otp })).success;
    if (!delivered) {
      // Record the failed attempt so send_count still counts against the cap.
      if (session) {
        await db
          .update(consentOtpVerifications)
          .set({ sendCount: session.sendCount + 1, deliveryStatus: "failed" })
          .where(eq(consentOtpVerifications.id, session.id));
      }
      return {
        ok: false,
        status: 502,
        error: `Failed to deliver consent OTP over ${channel}. Please try again.`,
      };
    }
    deliveryStatus = "sent";
  } else {
    console.log(
      `[consent-service] OTP provider (${channel}) not configured — using hardcoded OTP ${otp} for ${masked}.`,
    );
  }

  // Reuse-or-create the consent_records row for this (lead, consent_for).
  const [existingRec] = await db
    .select()
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.lead_id, opts.leadId),
        eq(consentRecords.consent_for, role),
      ),
    )
    .orderBy(desc(consentRecords.created_at))
    .limit(1);
  const consentId = existingRec?.id || newConsentId(now);

  const recordFields = {
    consent_type: "digital",
    sign_method: "otp",
    consent_status: "otp_sent",
    consent_delivery_channel: channel,
    consent_link_sent_at: now,
    generated_pdf_url: previewUrl,
    // Fresh OTP cycle — clear any stale Digio/signed state.
    esign_transaction_id: null,
    signer_aadhaar_masked: null,
    signer_name_match_score: null,
    esign_error_message: null,
    signed_at: null,
    signed_consent_url: null,
    verified_by: null,
    verified_at: null,
    otp_verified_at: null,
    otp_verification_id: null,
    initiated_by_tenant_id: opts.initiatedByTenantId ?? null,
    updated_at: now,
  };
  if (existingRec) {
    await db
      .update(consentRecords)
      .set(recordFields)
      .where(eq(consentRecords.id, existingRec.id));
  } else {
    await db.insert(consentRecords).values({
      id: consentId,
      lead_id: opts.leadId,
      consent_for: role,
      created_at: now,
      ...recordFields,
    });
  }

  // Persist / refresh the OTP session.
  if (session) {
    await db
      .update(consentOtpVerifications)
      .set({
        otpHash,
        expiresAt,
        sendCount: session.sendCount + 1,
        attemptCount: 0,
        lockedUntil: null,
        deliveryChannel: channel,
        deliveryStatus,
        consentRecordId: consentId,
        phone: storedPhone,
      })
      .where(eq(consentOtpVerifications.id, session.id));
  } else {
    await db.insert(consentOtpVerifications).values({
      leadId: opts.leadId,
      consentFor: role,
      consentRecordId: consentId,
      requestedBy: opts.requestedBy ?? null,
      phone: storedPhone,
      deliveryChannel: channel,
      otpHash,
      expiresAt,
      sendCount: 1,
      attemptCount: 0,
      deliveryStatus,
    });
  }

  await syncApplicantStatus(role, opts.leadId, "otp_sent", now);

  const nextSendCount = session ? session.sendCount + 1 : 1;
  const isDev = process.env.NODE_ENV !== "production";
  return {
    ok: true,
    consentId,
    consentFor: role,
    channel,
    phone: storedPhone,
    otpSentTo: masked,
    previewUrl,
    pdfBuffer,
    expiresInSeconds: Math.floor(OTP_LIFETIME_MS / 1000),
    sendCount: nextSendCount,
    maxSends: OTP_MAX_SENDS,
    deliveryStatus,
    ...(deliveryStatus === "dev_hardcoded" || isDev ? { devOtp: otp } : {}),
  };
}

export type VerifyConsentOtpResult =
  | {
      ok: true;
      consentId: string;
      consentFor: ConsentRole;
      verifiedAt: string;
      consentStatus: "verified";
    }
  | { ok: false; status: number; error: string; attemptsRemaining?: number };

/**
 * Verify a consent OTP. On success the consent AUTO-COMPLETES to 'verified'
 * (no admin review) and the applicant-level status is propagated exactly as the
 * admin verify route does. Deliberately does not touch kyc_status/final_decision.
 */
export async function verifyConsentOtp(opts: {
  leadId: string;
  otp: string;
  consentFor?: ConsentFor;
  verifiedBy?: string | null;
}): Promise<VerifyConsentOtpResult> {
  const role = toRole(opts.consentFor);

  const [session] = await db
    .select()
    .from(consentOtpVerifications)
    .where(
      and(
        eq(consentOtpVerifications.leadId, opts.leadId),
        eq(consentOtpVerifications.consentFor, role),
        isNull(consentOtpVerifications.verifiedAt),
        isNull(consentOtpVerifications.consumedAt),
      ),
    )
    .orderBy(desc(consentOtpVerifications.createdAt))
    .limit(1);

  if (!session) {
    return { ok: false, status: 400, error: "No active OTP. Please request a new one." };
  }

  const now = new Date();
  if (session.lockedUntil && now < session.lockedUntil) {
    const mins = Math.ceil((session.lockedUntil.getTime() - now.getTime()) / 60000);
    return { ok: false, status: 429, error: `Too many attempts. Locked for ${mins} more minute(s).` };
  }
  if (now >= session.expiresAt) {
    return { ok: false, status: 400, error: "OTP expired. Please resend." };
  }

  if (session.otpHash !== hashOtp(opts.otp)) {
    const attempts = session.attemptCount + 1;
    await db
      .update(consentOtpVerifications)
      .set({
        attemptCount: attempts,
        ...(attempts >= OTP_MAX_ATTEMPTS
          ? { lockedUntil: new Date(now.getTime() + OTP_LOCK_MS) }
          : {}),
      })
      .where(eq(consentOtpVerifications.id, session.id));
    return {
      ok: false,
      status: 400,
      error:
        attempts >= OTP_MAX_ATTEMPTS
          ? "Incorrect OTP. Too many attempts — locked for 5 minutes."
          : `Incorrect OTP. ${OTP_MAX_ATTEMPTS - attempts} attempt(s) remaining.`,
      attemptsRemaining: Math.max(0, OTP_MAX_ATTEMPTS - attempts),
    };
  }

  await db
    .update(consentOtpVerifications)
    .set({ verifiedAt: now })
    .where(eq(consentOtpVerifications.id, session.id));

  // Auto-complete the consent (mirror of admin/kyc/.../consent/.../verify).
  const [record] = await db
    .select()
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.lead_id, opts.leadId),
        eq(consentRecords.consent_for, role),
      ),
    )
    .orderBy(desc(consentRecords.created_at))
    .limit(1);

  const consentId = record?.id || session.consentRecordId || newConsentId(now);
  if (record) {
    await db
      .update(consentRecords)
      .set({
        consent_status: "verified",
        sign_method: "otp",
        signed_at: now,
        verified_at: now,
        verified_by: opts.verifiedBy ?? null,
        otp_verified_at: now,
        otp_verification_id: session.id,
        signed_consent_url: record.signed_consent_url ?? record.generated_pdf_url ?? null,
        updated_at: now,
      })
      .where(eq(consentRecords.id, record.id));
  } else {
    await db.insert(consentRecords).values({
      id: consentId,
      lead_id: opts.leadId,
      consent_for: role,
      consent_type: "digital",
      consent_status: "verified",
      sign_method: "otp",
      signed_at: now,
      verified_at: now,
      verified_by: opts.verifiedBy ?? null,
      otp_verified_at: now,
      otp_verification_id: session.id,
      created_at: now,
      updated_at: now,
    });
  }

  await syncApplicantStatus(role, opts.leadId, "verified", now);

  return {
    ok: true,
    consentId,
    consentFor: role,
    verifiedAt: now.toISOString(),
    consentStatus: "verified",
  };
}

export type SignedConsentLookup =
  | { signed: true; url: string | null; pdfBuffer: Buffer | null }
  | { signed: false };

/**
 * Resolve whether a lead's (digital) consent has been signed. Reads the local
 * consent_records first; if still pending, polls Digio directly (so the dealer
 * isn't blocked when the async webhook hasn't landed — common in dev). On a
 * fresh completion it stores the signed PDF, marks the record esign_completed,
 * syncs the applicant status, and surfaces the lead to the admin KYC queue.
 * Returns the signed PDF bytes when available, for reliable WhatsApp delivery.
 */
export async function getSignedConsentForLead(
  leadId: string,
  consentFor: ConsentFor = "customer",
): Promise<SignedConsentLookup> {
  const role = toRole(consentFor);
  const [record] = await db
    .select()
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.lead_id, leadId),
        eq(consentRecords.consent_for, role),
      ),
    )
    .orderBy(desc(consentRecords.created_at))
    .limit(1);
  if (!record) return { signed: false };

  const SIGNED_LOCAL = new Set([
    "signed",
    "esign_completed",
    "admin_review_pending",
  ]);
  const docId = record.esign_transaction_id;
  let isSigned = SIGNED_LOCAL.has(record.consent_status || "");

  // Not known signed locally → ask Digio directly.
  if (!isSigned && docId) {
    try {
      const status = await getDigioDocumentStatus(docId);
      const raw = String(
        (status as any)?.agreement_status || (status as any)?.status || "",
      ).toLowerCase();
      const digioSigned = ["signed", "completed", "executed", "success"].includes(raw);

      if (digioSigned) {
        // Integrity gate (mirror of the webhook). Digio reporting "completed" is
        // NOT enough — the Aadhaar that signed must match the captured Aadhaar.
        // Without this, the chat "Check if signed" path would show a mismatched
        // signature as success, bypassing the webhook's rejection.
        const signerIdentity = getConsentSignerIdentity(status);
        const expected = await getExpectedConsentAadhaar(leadId, role);
        const check = checkAadhaarMatch(expected, signerIdentity.suffix);
        if (check.comparable && !check.match) {
          const nowMismatch = new Date();
          const retryCount = (record.esign_retry_count || 0) + 1;
          const newStatus = retryCount >= 3 ? "esign_blocked" : "esign_failed";
          console.warn("[consent-service] Aadhaar mismatch — rejecting consent", {
            documentId: docId,
            leadId,
            consentFor: role,
            signerLast4: check.signerLast4,
            expectedLast4: check.expectedLast4,
          });
          await db
            .update(consentRecords)
            .set({
              consent_status: newStatus,
              signer_aadhaar_masked: signerIdentity.suffix,
              signer_name_match_score: signerIdentity.nameScore,
              esign_retry_count: retryCount,
              esign_error_message: aadhaarMismatchMessage(check),
              updated_at: nowMismatch,
            })
            .where(eq(consentRecords.id, record.id));
          await syncApplicantStatus(role, leadId, newStatus, nowMismatch);
          return { signed: false };
        }
        isSigned = true;
      }
    } catch (e) {
      console.warn("[consent-service] Digio status poll failed:", e);
    }
  }

  if (!isSigned) return { signed: false };

  // Ensure the signed PDF is stored + the record/state/queue reflect completion.
  const now = new Date();
  let url = record.signed_consent_url ?? null;
  if (!url && docId) {
    try {
      const stored = await fetchAndStoreSignedConsent(docId, leadId);
      url = stored?.publicUrl ?? null;
    } catch (e) {
      console.warn("[consent-service] signed PDF store failed:", e);
    }
  }
  if (!SIGNED_LOCAL.has(record.consent_status || "")) {
    await db
      .update(consentRecords)
      .set({
        consent_status: "esign_completed",
        signed_consent_url: url,
        signed_at: record.signed_at ?? now,
        updated_at: now,
      })
      .where(eq(consentRecords.id, record.id));
    await syncApplicantStatus(role, leadId, "esign_completed", now);
  }
  await ensureAdminKycQueueEntry(leadId);

  // E-243 — see storeSignedConsent: start the auto-verify clock on the signed
  // consent. Best-effort; the sweep does the verifying once it expires.
  stampConsentAutoVerifyDeadline(leadId).catch(() => {});

  // Download the bytes so WhatsApp can send the PDF by upload (its storage URL
  // may not be publicly reachable).
  let pdfBuffer: Buffer | null = null;
  if (docId) {
    try {
      const data = await downloadDigioSignedDocument(docId);
      pdfBuffer = Buffer.from(data as ArrayBuffer);
    } catch (e) {
      console.warn("[consent-service] signed PDF download failed:", e);
    }
  }
  return { signed: true, url, pdfBuffer };
}
