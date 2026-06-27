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

import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  coBorrowers,
  consentRecords,
  kycVerifications,
  leads,
} from "@/lib/db/schema";
import { generateConsentHtml } from "@/lib/consent/consent-pdf-template";
import {
  createDigioAgreement,
  downloadDigioSignedDocument,
  getDigioDocumentStatus,
} from "@/lib/digio/service";
import { fetchAndStoreSignedConsent } from "@/lib/digio/fetch-signed-consent";
import { createWorkflowId } from "@/lib/kyc/admin-workflow";
import { ensureAdminKycQueueEntry } from "@/lib/kyc/admin-workflow";
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
  channel: "sms" | "whatsapp";
  consentFor?: ConsentFor;
  dealerName?: string;
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
  const refreshable = existing
    .filter((r) => ["failed", "expired", "rejected"].includes(r.consent_status || ""))
    .sort(
      (a, b) =>
        (b.updated_at?.getTime?.() ?? 0) - (a.updated_at?.getTime?.() ?? 0),
    )[0];

  const now = new Date();
  const consentId = newConsentId(now);
  const html = buildHtml(lead, signer, consentId, opts.dealerName || "", now);
  const pdfBuffer = await renderPdfFromHtml(html);
  const pdfBase64 = pdfBuffer.toString("base64");
  const cleanPhone = signer.phone.replace(/\D/g, "").slice(-10);

  // Unsigned-PDF storage + Digio agreement run in parallel (both network-bound).
  const bucket = (process.env.CONSENT_STORAGE_BUCKET || "documents").trim();
  const storagePath = `kyc/${opts.leadId}/consent/unsigned-${Date.now()}.pdf`;
  const storageUploadPromise: Promise<string | null> = (async () => {
    try {
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
    fileName: `consent_${opts.leadId}_${consentId}.pdf`,
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
      isSigned = ["signed", "completed", "executed", "success"].includes(raw);
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
