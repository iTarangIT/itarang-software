export const runtime = "nodejs";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { coBorrowers, consentRecords, kycVerifications, leads, users } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { generateConsentHtml } from "@/lib/consent/consent-pdf-template";
import { createDigioAgreement } from "@/lib/digio/service";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createWorkflowId } from "@/lib/kyc/admin-workflow";
import { launchBrowser } from "@/lib/pdf/launch-browser";
type RouteContext = {
  params: Promise<{ leadId: string }>;
};

async function renderPdfFromHtml(html: string): Promise<Buffer> {
  // Browser is pooled across requests by launchBrowser(); we only close the
  // per-request Page. The consent HTML has no external resources (logo is
  // inlined as base64), so 'domcontentloaded' is sufficient — 'networkidle0'
  // would idle-wait ~500ms for traffic that never arrives.
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

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const user = await requireRole(["dealer", "admin", "ceo", "sales_head"]);
    const { leadId } = await params;
    const body = await req.json().catch(() => ({}));
    const channel = String(body?.channel || "sms").toLowerCase();

    if (!["sms", "whatsapp"].includes(channel)) {
      return NextResponse.json(
        { success: false, error: { message: "Channel must be sms or whatsapp" } },
        { status: 400 }
      );
    }

    // Normalize the applicant the consent is for. Dealer page sends 'customer'
    // for Step 2 and 'borrower' for Step 3. Persist as 'primary' / 'co_borrower'
    // so the rest of the system (admin review, status polling) can match.
    const rawConsentFor = String(body?.consent_for || "customer").toLowerCase();
    const consentForRole: "primary" | "co_borrower" =
      rawConsentFor === "borrower" || rawConsentFor === "co_borrower"
        ? "co_borrower"
        : "primary";

    // Fetch lead
    const leadRows = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    const lead = leadRows[0];

    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 }
      );
    }

    // Resolve applicant data — primary uses lead fields, co-borrower uses the
    // coBorrowers row so the e-sign link is delivered to the co-borrower's
    // phone (not the primary applicant's).
    let signerPhone: string | null;
    let signerName: string;
    let signerEmail: string;
    let signerFatherName: string;
    let signerDob: string | null;
    let signerCurrentAddress: string;
    let signerPermanentAddress: string;

    if (consentForRole === "co_borrower") {
      const cobRows = await db
        .select()
        .from(coBorrowers)
        .where(eq(coBorrowers.lead_id, leadId))
        .limit(1);
      const cob = cobRows[0];
      if (!cob) {
        return NextResponse.json(
          { success: false, error: { message: "Co-borrower not found for this lead" } },
          { status: 404 }
        );
      }
      signerPhone = cob.phone || null;
      signerName = cob.full_name || "Co-borrower";
      signerEmail = "";
      signerFatherName = cob.father_or_husband_name || "";
      signerDob = (cob.dob as unknown as string) || null;
      signerCurrentAddress = cob.current_address || cob.address || "";
      signerPermanentAddress = cob.permanent_address || cob.address || "";
    } else {
      signerPhone = lead.phone || lead.owner_contact;
      signerName = lead.full_name || lead.owner_name || "Customer";
      signerEmail = lead.owner_email || "";
      signerFatherName = lead.father_or_husband_name || "";
      signerDob = (lead.dob as unknown as string) || null;
      signerCurrentAddress = lead.current_address || "";
      signerPermanentAddress = lead.permanent_address || lead.current_address || "";
    }

    if (!signerPhone) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message:
              consentForRole === "co_borrower"
                ? "Co-borrower phone number not available"
                : "Customer phone number not available",
          },
        },
        { status: 400 }
      );
    }

    // Idempotency: if there's already an active consent record for THIS
    // applicant on this lead, return it instead of generating a new PDF +
    // Digio agreement (which previously created duplicate consent_records and
    // produced two cards in the admin UI). Statuses that count as
    // "still active": link_sent, viewed, signed, esign_completed.
    // Failed / expired rows are allowed to be retried — we'll UPDATE that row
    // below instead of inserting a new one.
    const existingConsents = await db
      .select()
      .from(consentRecords)
      .where(
        and(
          eq(consentRecords.lead_id, leadId),
          eq(consentRecords.consent_for, consentForRole),
        ),
      );

    const ACTIVE_STATUSES = new Set([
      "link_sent",
      "viewed",
      "signed",
      "esign_completed",
    ]);
    const activeConsent = existingConsents.find((r) =>
      ACTIVE_STATUSES.has(r.consent_status || ""),
    );
    if (activeConsent) {
      return NextResponse.json({
        success: true,
        replaced: false,
        alreadyActive: true,
        hasDigioIntegration: true,
        data: {
          consentId: activeConsent.id,
          leadId,
          channel: activeConsent.consent_delivery_channel,
          phone: signerPhone,
          customerSigningUrl: activeConsent.consent_link_url,
          digioDocumentId: activeConsent.esign_transaction_id,
          sentAt: activeConsent.consent_link_sent_at?.toISOString() ?? null,
          message:
            "An active consent already exists for this lead — reusing the existing link instead of creating a duplicate.",
        },
      });
    }

    // Existing failed/expired row to refresh (UPDATE instead of new INSERT).
    const refreshableConsent = existingConsents
      .filter((r) =>
        ["failed", "expired", "rejected"].includes(r.consent_status || ""),
      )
      .sort(
        (a, b) =>
          (b.updated_at?.getTime?.() ?? 0) - (a.updated_at?.getTime?.() ?? 0),
      )[0];

    // Fetch dealer name
    let dealerName = "";
    if (user.id) {
      const userRows = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
      if (userRows.length) dealerName = userRows[0].name || "";
    }

    // Generate consent ID
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
    const seq = Math.floor(Math.random() * 10000).toString().padStart(4, "0");
    const consentId = `CONSENT-${dateStr}-${seq}`;

    const generatedDate = `${now.getDate().toString().padStart(2, "0")}/${(now.getMonth() + 1).toString().padStart(2, "0")}/${now.getFullYear()}`;

    // Format DOB
    let dobFormatted = "";
    if (signerDob) {
      const d = new Date(signerDob);
      if (!Number.isNaN(d.getTime())) {
        dobFormatted = `${d.getDate().toString().padStart(2, "0")}/${(d.getMonth() + 1).toString().padStart(2, "0")}/${d.getFullYear()}`;
      }
    }

    // 1. Generate consent PDF
    const html = generateConsentHtml({
      customerName: signerName,
      fatherOrHusbandName: signerFatherName,
      dob: dobFormatted,
      phone: signerPhone,
      customerEmail: signerEmail,
      currentAddress: signerCurrentAddress,
      permanentAddress: signerPermanentAddress,
      productName: lead.asset_model || "",
      productCategory: lead.asset_model || "",
      paymentMethod: lead.payment_method || "",
      dealerName,
      dealerCompany: "",
      leadId,
      consentId,
      generatedDate,
    });

    const pdfBuffer = await renderPdfFromHtml(html);
    const pdfBase64 = pdfBuffer.toString("base64");

    // Digio needs 10-digit mobile number
    const cleanPhone = signerPhone.replace(/\D/g, "").slice(-10);

    // Run the unsigned-PDF Supabase upload and the Digio agreement creation in
    // parallel — both are network-bound and independent, so overlapping them
    // roughly halves the post-render latency.
    const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
    const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
    const bucket = (process.env.CONSENT_STORAGE_BUCKET || "documents").trim();

    const storageUploadPromise: Promise<string | null> =
      supabaseUrl && serviceRoleKey
        ? (async () => {
            try {
              const supabase = createSupabaseClient(supabaseUrl, serviceRoleKey);
              const storagePath = `kyc/${leadId}/consent/unsigned-${Date.now()}.pdf`;
              const { error: upErr } = await supabase.storage
                .from(bucket)
                .upload(storagePath, pdfBuffer, {
                  contentType: "application/pdf",
                  upsert: true,
                });
              if (upErr) {
                console.warn("[Send Consent] Failed to store unsigned PDF:", upErr.message);
                return null;
              }
              const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(storagePath);
              return urlData?.publicUrl || null;
            } catch (e) {
              console.warn("[Send Consent] Unsigned PDF storage error:", e);
              return null;
            }
          })()
        : Promise.resolve(null);

    const digioPromise = createDigioAgreement({
      fileData: pdfBase64,
      fileName: `consent_${leadId}_${consentId}.pdf`,
      signers: [
        {
          identifier: cleanPhone,
          name: signerName,
          reason:
            consentForRole === "co_borrower"
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

    console.log("[Send Consent] Digio response:", JSON.stringify(digioResponse, null, 2));

    // Extract Digio details
    const digioDocumentId = digioResponse?.id || digioResponse?.document_id || null;
    const signingParties = digioResponse?.signing_parties || [];
    const customerSigningUrl = signingParties[0]?.authentication_url || signingParties[0]?.authenticationUrl || null;

    if (!digioDocumentId) {
      console.error("[Send Consent] Digio did not return document ID:", digioResponse);
      return NextResponse.json(
        { success: false, error: { message: "Failed to create consent document with eSign provider. Check DigiO credentials." } },
        { status: 500 }
      );
    }

    // 3. Upsert consent record. If a previous row was failed/expired, UPDATE
    // it (resend semantics). Otherwise, INSERT new. Avoids the duplicate-row
    // problem that produced two "Primary Consent" cards in admin UI.
    const finalConsentId = refreshableConsent?.id || consentId;
    if (refreshableConsent) {
      await db
        .update(consentRecords)
        .set({
          consent_status: "link_sent",
          consent_delivery_channel: channel,
          consent_link_url: customerSigningUrl,
          consent_link_sent_at: now,
          esign_transaction_id: digioDocumentId,
          generated_pdf_url: generatedPdfUrl,
          updated_at: now,
        })
        .where(eq(consentRecords.id, refreshableConsent.id));
    } else {
      await db.insert(consentRecords).values({
        id: consentId,
        lead_id: leadId,
        consent_for: consentForRole,
        consent_type: "digital",
        consent_status: "link_sent",
        consent_delivery_channel: channel,
        consent_link_url: customerSigningUrl,
        consent_link_sent_at: now,
        esign_transaction_id: digioDocumentId,
        generated_pdf_url: generatedPdfUrl,
        created_at: now,
        updated_at: now,
      });
    }

    // Persist raw DigiO provider response for audit. Upsert by
    // (lead_id, verification_type='esign_consent', applicant) so polling /
    // resends don't pile up duplicate audit rows that would later block the
    // final-decision approval gate. Non-fatal.
    try {
      const existingAudit = await db
        .select({ id: kycVerifications.id })
        .from(kycVerifications)
        .where(
          and(
            eq(kycVerifications.lead_id, leadId),
            eq(kycVerifications.verification_type, "esign_consent"),
            eq(kycVerifications.applicant, consentForRole),
          ),
        )
        .limit(1);

      if (existingAudit[0]) {
        await db
          .update(kycVerifications)
          .set({
            status: "success",
            api_provider: "digio",
            api_request: { consent_id: finalConsentId, channel, phone: cleanPhone },
            api_response: digioResponse as unknown as Record<string, unknown>,
            completed_at: now,
            updated_at: now,
          })
          .where(eq(kycVerifications.id, existingAudit[0].id));
      } else {
        await db.insert(kycVerifications).values({
          id: createWorkflowId("KYCVER", now),
          lead_id: leadId,
          verification_type: "esign_consent",
          applicant: consentForRole,
          status: "success",
          api_provider: "digio",
          api_request: { consent_id: finalConsentId, channel, phone: cleanPhone },
          api_response: digioResponse as unknown as Record<string, unknown>,
          submitted_at: now,
          completed_at: now,
        });
      }
    } catch (persistErr) {
      console.error("[send-consent] kyc_verifications upsert failed:", persistErr);
    }

    // 4. Update consent status on the appropriate applicant-level rows
    if (consentForRole === "co_borrower") {
      await db.update(coBorrowers)
        .set({ consent_status: "link_sent", updated_at: now })
        .where(eq(coBorrowers.lead_id, leadId));
      await db.update(leads)
        .set({ borrower_consent_status: "link_sent", updated_at: now })
        .where(eq(leads.id, leadId));
    } else {
      await db.update(leads)
        .set({ consent_status: "link_sent", updated_at: now })
        .where(eq(leads.id, leadId));
    }

    return NextResponse.json({
      success: true,
      replaced: !!refreshableConsent,
      hasDigioIntegration: true,
      data: {
        consentId: finalConsentId,
        leadId,
        channel,
        phone: cleanPhone,
        customerSigningUrl,
        digioDocumentId,
        sentAt: now.toISOString(),
        message:
          consentForRole === "co_borrower"
            ? `Consent form sent to co-borrower via DigiO. Signing link delivered to ${cleanPhone}.`
            : `Consent form sent to customer via DigiO. Signing link delivered to ${cleanPhone}.`,
      },
    });
  } catch (error: any) {
    console.error("[Send Consent] Error:", error);
    const message = error instanceof Error ? error.message : "Server error";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 }
    );
  }
}
