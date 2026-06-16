import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import {
  dealerAgreementSigners,
  dealerOnboardingApplications,
  whatsappMessages,
} from "@/lib/db/schema";
import {
  insertAgreementEvent,
  insertAgreementSigners,
} from "@/lib/agreement/tracking";
import { mergeProviderRawResponse } from "@/lib/agreement/providerRaw";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import { getAdapter } from "@/lib/whatsapp";
import { POST as createDigioAgreement } from "@/app/api/integrations/digio/create-agreement/route";
import { extractStampCertificateIds } from "@/lib/digio/parse-status";

type AgreementParty = {
  name?: string | null;
  designation?: string | null;
  email?: string | null;
  mobile?: string | null;
  address?: string | null;
  signingMethod?: string | null;
};

type AgreementConfig = {
  agreementName?: string | null;
  agreementVersion?: string | null;
  dateOfSigning?: string | null;
  mouDate?: string | null;
  financierName?: string | null;

  dealerSignerName?: string | null;
  dealerSignerDesignation?: string | null;
  dealerSignerEmail?: string | null;
  dealerSignerPhone?: string | null;
  dealerSigningMethod?: string | null;

  financierSignatory?: AgreementParty | null;
  itarangSignatory1?: AgreementParty | null;
  itarangSignatory2?: AgreementParty | null;

  signingOrder?: string[] | null;

  isOemFinancing?: boolean;
  vehicleType?: string | null;
  manufacturer?: string | null;
  brand?: string | null;
  statePresence?: string | null;
};

type RequestBody = {
  agreementConfig?: AgreementConfig;
};

function cleanString(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizePhone(value: unknown) {
  return String(value || "").replace(/[^\d]/g, "");
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidPhone(value: string) {
  const digits = normalizePhone(value);
  return digits.length >= 10 && digits.length <= 15;
}

function mapSigningMethod(method?: string | null) {
  const safe = cleanString(method).toLowerCase();

  if (safe === "aadhaar_esign") return "aadhaar_esign";
  if (safe === "electronic_signature") return "electronic_signature";
  if (safe === "dsc_signature") return "dsc_signature";

  return "aadhaar_esign";
}

function buildSigner(params: {
  name?: string | null;
  email?: string | null;
  mobile?: string | null;
  reason: string;
  signingMethod?: string | null;
}) {
  const name = cleanString(params.name);
  const email = cleanString(params.email);
  const mobile = normalizePhone(params.mobile);

  if (!name) return null;
  if (!email || !isValidEmail(email)) return null;
  if (!mobile || !isValidPhone(mobile)) return null;

  return {
    name,
    email,
    mobile,
    reason: params.reason,
    signingMethod: mapSigningMethod(params.signingMethod),
  };
}

function pickFirstString(...values: unknown[]) {
  for (const value of values) {
    const safe = cleanString(value);
    if (safe) return safe;
  }
  return null;
}

function extractProviderDocumentId(data: any) {
  return pickFirstString(
    data?.providerDocumentId,
    data?.provider_document_id,
    data?.documentId,
    data?.document_id,
    data?.id,
    data?.agreement_id,
    data?.agreement?.id,
    data?.agreement?.documentId,
    data?.agreement?.document_id,
    data?.raw?.documentId,
    data?.raw?.document_id,
    data?.raw?.id
  );
}

function extractRequestId(data: any) {
  return pickFirstString(
    data?.requestId,
    data?.request_id,
    data?.id,
    data?.agreement?.requestId,
    data?.agreement?.request_id,
    data?.agreement?.id,
    data?.raw?.requestId,
    data?.raw?.request_id,
    data?.raw?.id
  );
}

function extractSigningUrl(data: any) {
  return pickFirstString(
    data?.signingUrl,
    data?.signing_url,
    data?.providerSigningUrl,
    data?.provider_signing_url,
    data?.authentication_url,
    data?.authenticationUrl,
    data?.agreement?.signing_url,
    data?.agreement?.provider_signing_url,
    data?.agreement?.authentication_url,
    data?.raw?.signing_url,
    data?.raw?.authentication_url,
    data?.signing_parties?.[0]?.authentication_url,
    data?.signing_parties?.[0]?.authenticationUrl,
    data?.signing_parties?.[0]?.sign_url,
    data?.signing_parties?.[0]?.signUrl,
    data?.raw?.signing_parties?.[0]?.authentication_url,
    data?.raw?.signing_parties?.[0]?.authenticationUrl,
    data?.raw?.signing_parties?.[0]?.sign_url,
    data?.raw?.signing_parties?.[0]?.signUrl
  );
}

function extractStampStatus(data: any) {
  return pickFirstString(
    data?.stampStatus,
    data?.stamp_status,
    data?.agreement?.stamp_status,
    data?.raw?.stamp_status
  );
}

function extractAgreementStatus(data: any) {
  return (
    pickFirstString(
      data?.agreementStatus,
      data?.agreement_status,
      data?.status,
      data?.agreement?.agreement_status,
      data?.agreement?.status,
      data?.raw?.agreement_status,
      data?.raw?.status
    ) || "requested"
  );
}

function extractSignerUrls(data: any) {
  if (Array.isArray(data?.signerUrls)) return data.signerUrls;
  if (Array.isArray(data?.signer_urls)) return data.signer_urls;
  if (Array.isArray(data?.signers)) return data.signers;
  if (Array.isArray(data?.signing_parties)) return data.signing_parties;
  if (Array.isArray(data?.raw?.signerUrls)) return data.raw.signerUrls;
  if (Array.isArray(data?.raw?.signer_urls)) return data.raw.signer_urls;
  if (Array.isArray(data?.raw?.signers)) return data.raw.signers;
  if (Array.isArray(data?.raw?.signing_parties)) return data.raw.signing_parties;
  return [];
}

function normalizeSignerStatus(value: unknown) {
  const safe = cleanString(value).toLowerCase();

  if (!safe) return "sent";
  if (safe === "requested") return "sent";
  if (safe === "sequenced") return "sent";

  return safe;
}

function getSignerUrl(item: any) {
  return (
    pickFirstString(
      item?.authenticationUrl,
      item?.authentication_url,
      item?.providerSigningUrl,
      item?.provider_signing_url,
      item?.signUrl,
      item?.sign_url,
      item?.url
    ) || null
  );
}

type ExistingSignerRow = {
  signer_name?: string | null;
  signer_email?: string | null;
  signer_mobile?: string | null;
  signing_method?: string | null;
  created_at?: Date | string;
};

// Fill a signer party's missing name/email/mobile from a previously-saved
// dealer_agreement_signers row. Values present in the incoming config always
// win; the existing row only backfills blanks.
function hydrateParty(
  party: AgreementParty | null | undefined,
  existing: ExistingSignerRow | undefined
): AgreementParty | null {
  if (!existing) return party ?? null;
  return {
    ...(party || {}),
    name: cleanString(party?.name) || existing.signer_name || "",
    email: cleanString(party?.email) || existing.signer_email || "",
    mobile: normalizePhone(party?.mobile) || existing.signer_mobile || "",
    signingMethod:
      cleanString(party?.signingMethod) ||
      existing.signing_method ||
      "aadhaar_esign",
  };
}

// Same as hydrateParty but keeps the optional iTarang signer 2 null when there
// is neither incoming data nor a saved row — so we don't fabricate a 3rd signer.
function hydrateOptionalParty(
  party: AgreementParty | null | undefined,
  existing: ExistingSignerRow | undefined
): AgreementParty | null {
  const started = !!(party?.name || party?.email || party?.mobile);
  if (!started && !existing) return null;
  return hydrateParty(party, existing);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ dealerId: string }> }
) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;
  try {
    const { dealerId } = await params;

    let body: RequestBody = {};
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      body = {};
    }

    const applicationRows = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, dealerId))
      .limit(1);

    const application = applicationRows[0];

    if (!application) {
      return NextResponse.json(
        { success: false, message: "Application not found" },
        { status: 404 }
      );
    }

    if (!application.finance_enabled) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Agreement can only be initiated for finance-enabled applications.",
        },
        { status: 400 }
      );
    }

    const isWhatsappDealer =
      String(application.source || "").toLowerCase() === "whatsapp";

    const currentAgreementStatus = String(
      application.agreement_status || ""
    ).toLowerCase();

    const canInitiateStatuses = ["", "not_generated", "failed", "expired"];

    if (!canInitiateStatuses.includes(currentAgreementStatus)) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Agreement already exists for this application. Use refresh or re-initiate only after failed or expired state.",
        },
        { status: 400 }
      );
    }

    const agreement = body.agreementConfig;

    if (!agreement) {
      return NextResponse.json(
        {
          success: false,
          message:
            "agreementConfig is required in request body. Admin initiation needs full Step 5 agreement data.",
        },
        { status: 400 }
      );
    }

    // Recover signer details from previously-saved agreement signers when the
    // saved agreement config (provider_raw_response.agreement) is incomplete.
    // The admin "Initiate / Re-initiate" button rebuilds the signer payload
    // from that config; for some applications it's missing the dealer / iTarang
    // signer fields even though a prior initiation already persisted full signer
    // rows in dealer_agreement_signers (the Agreement Tracking Table). Without
    // this fallback, re-initiation 400s with "Dealer and iTarang Signer 1 must
    // have valid name, email, and phone" even though the data exists and the
    // signers were already sent.
    const existingSignerRows = await db
      .select()
      .from(dealerAgreementSigners)
      .where(eq(dealerAgreementSigners.application_id, application.id));

    const existingSignerByRole = new Map<
      string,
      (typeof existingSignerRows)[number]
    >();
    for (const rowSigner of existingSignerRows) {
      const prior = existingSignerByRole.get(rowSigner.signer_role);
      if (
        !prior ||
        new Date(rowSigner.created_at).getTime() >
          new Date(prior.created_at).getTime()
      ) {
        existingSignerByRole.set(rowSigner.signer_role, rowSigner);
      }
    }

    const dealerExisting = existingSignerByRole.get("dealer");
    const itarang1Existing = existingSignerByRole.get("itarang_signatory_1");
    const itarang2Existing = existingSignerByRole.get("itarang_signatory_2");

    // For WhatsApp-onboarded dealers there is no web Step-5 agreement config, so
    // the incoming dealerSigner* fields are blank. Fall back to the application's
    // owner contact (owner_name/email/phone) — captured during the WhatsApp flow —
    // so the dealer signer is always valid without forcing a manual re-entry.
    const hydratedAgreement: AgreementConfig = {
      ...agreement,
      dealerSignerName:
        cleanString(agreement.dealerSignerName) ||
        dealerExisting?.signer_name ||
        cleanString(application.owner_name) ||
        "",
      dealerSignerEmail:
        cleanString(agreement.dealerSignerEmail) ||
        dealerExisting?.signer_email ||
        cleanString(application.owner_email) ||
        "",
      dealerSignerPhone:
        normalizePhone(agreement.dealerSignerPhone) ||
        dealerExisting?.signer_mobile ||
        normalizePhone(application.owner_phone) ||
        "",
      dealerSigningMethod:
        cleanString(agreement.dealerSigningMethod) ||
        dealerExisting?.signing_method ||
        "aadhaar_esign",
      itarangSignatory1: hydrateParty(
        agreement.itarangSignatory1,
        itarang1Existing
      ),
      itarangSignatory2: hydrateOptionalParty(
        agreement.itarangSignatory2,
        itarang2Existing
      ),
    };

    const dealerSigner = buildSigner({
      name: hydratedAgreement.dealerSignerName,
      email: hydratedAgreement.dealerSignerEmail,
      mobile: hydratedAgreement.dealerSignerPhone,
      reason: "dealer signer",
      signingMethod: hydratedAgreement.dealerSigningMethod || "aadhaar_esign",
    });

    const itarangSigner1 = buildSigner({
      name: hydratedAgreement.itarangSignatory1?.name,
      email: hydratedAgreement.itarangSignatory1?.email,
      mobile: hydratedAgreement.itarangSignatory1?.mobile,
      reason: "iTarang signer 1",
      signingMethod:
        hydratedAgreement.itarangSignatory1?.signingMethod || "aadhaar_esign",
    });

    const itarangSigner2 = buildSigner({
      name: hydratedAgreement.itarangSignatory2?.name,
      email: hydratedAgreement.itarangSignatory2?.email,
      mobile: hydratedAgreement.itarangSignatory2?.mobile,
      reason: "iTarang signer 2",
      signingMethod:
        hydratedAgreement.itarangSignatory2?.signingMethod || "aadhaar_esign",
    });

    if (!dealerSigner || !itarangSigner1) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Dealer and iTarang Signer 1 must have valid name, email, and phone.",
          debug: {
            dealerSigner,
            itarangSigner1,
          },
        },
        { status: 400 }
      );
    }

    const signer2Started =
      !!hydratedAgreement.itarangSignatory2?.name ||
      !!hydratedAgreement.itarangSignatory2?.email ||
      !!hydratedAgreement.itarangSignatory2?.mobile;

    if (signer2Started && !itarangSigner2) {
      return NextResponse.json(
        {
          success: false,
          message:
            "iTarang Signer 2 is optional, but if provided, all fields must be valid.",
        },
        { status: 400 }
      );
    }

    const signers = [dealerSigner, itarangSigner1];

    if (itarangSigner2) {
      signers.push(itarangSigner2);
    }

    const finalSigningOrder =
      agreement.signingOrder && agreement.signingOrder.length > 0
        ? agreement.signingOrder
        : itarangSigner2
          ? ["dealer", "itarang_1", "itarang_2"]
          : ["dealer", "itarang_1"];

    const createAgreementPayload = {
      applicationId: application.id,
      company: {
        companyName: application.company_name || "",
        companyType: application.company_type || "",
        companyAddress:
          typeof application.business_address === "object" &&
          application.business_address &&
          "address" in application.business_address
            ? String((application.business_address as any).address || "")
            : "",
        gstNumber: application.gst_number || "",
        panNumber: application.pan_number || "",
      },
      ownership: {
        ownerName: application.owner_name || "",
        ownerPhone: application.owner_phone || "",
        ownerEmail: application.owner_email || "",
        businessAddress: application.business_address || {},
        bankName: application.bank_name || "",
        accountNumber: application.account_number || "",
        ifscCode: application.ifsc_code || "",
        beneficiaryName: application.beneficiary_name || "",
      },
      agreement: {
        agreementName:
          cleanString(agreement.agreementName) ||
          "Dealer Finance Enablement Agreement",
        agreementVersion: cleanString(agreement.agreementVersion) || "v1.0",
        dateOfSigning: cleanString(agreement.dateOfSigning),
        mouDate: cleanString(agreement.mouDate),
        financierName: "",
        dealerSignerName: cleanString(hydratedAgreement.dealerSignerName),
        dealerSignerDesignation: cleanString(agreement.dealerSignerDesignation),
        dealerSignerEmail: cleanString(hydratedAgreement.dealerSignerEmail),
        dealerSignerPhone: normalizePhone(hydratedAgreement.dealerSignerPhone),
        dealerSigningMethod:
          cleanString(hydratedAgreement.dealerSigningMethod) || "aadhaar_esign",
        financierSignatory: null,
        itarangSignatory1: hydratedAgreement.itarangSignatory1 || null,
        itarangSignatory2: itarangSigner2
          ? hydratedAgreement.itarangSignatory2 || null
          : null,
        signingOrder: finalSigningOrder,
        isOemFinancing: !!agreement.isOemFinancing,
        vehicleType: cleanString(agreement.vehicleType),
        manufacturer: cleanString(agreement.manufacturer),
        brand: cleanString(agreement.brand),
        statePresence: cleanString(agreement.statePresence),
        signers,
        sequential: true,
        expireInDays: 30,
        // Keep Digio's email/SMS notifications ON so the iTarang signer is
        // notified by email (requirement). Digio's notify flag is global — there
        // is no per-signer suppression — so the dealer may also receive a Digio
        // email, but their PRIMARY channel is the WhatsApp link we send below.
        suppressSignerEmails: false,
      },
      applicationId: dealerId,
      // Persist the unsigned PDF only for WhatsApp dealers — we send it as a
      // WhatsApp document below. Web dealers don't need the extra storage.
      storeUnsignedCopy: isWhatsappDealer,
    };

    console.log(
      "[DIGIO INITIATE] createAgreementPayload:",
      JSON.stringify(createAgreementPayload, null, 2)
    );

    // Call the Digio integration handler in-process. Earlier we did an HTTP
    // fetch to `${origin}/api/integrations/digio/create-agreement`, which is
    // brittle behind reverse proxies (Hostinger returned "fetch failed"
    // because the server can't dial its own public URL). Invoking the
    // handler directly keeps it on the same Node process and surfaces the
    // real downstream error (e.g. Puppeteer launch issues) instead of an
    // opaque network failure.
    const internalReq = new NextRequest(
      new Request(`${req.nextUrl.origin}/api/integrations/digio/create-agreement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createAgreementPayload),
      })
    );
    const digioResponse = await createDigioAgreement(internalReq);

    let digioJson: any = null;
    try {
      digioJson = await digioResponse.json();
    } catch {
      digioJson = null;
    }

    console.log(
      "[DIGIO INITIATE] integration status:",
      digioResponse.status,
      digioResponse.statusText
    );
    console.log(
      "[DIGIO INITIATE] full integration response:",
      JSON.stringify(digioJson, null, 2)
    );

    if (!digioResponse.ok || !digioJson?.success) {
      return NextResponse.json(
        {
          success: false,
          message: digioJson?.message || "Failed to initiate Digio agreement",
          raw: digioJson || null,
        },
        { status: 500 }
      );
    }

    const responseData = digioJson?.data || {};

    const requestId = extractRequestId(responseData);
    const providerDocumentId =
      extractProviderDocumentId(responseData) || requestId || null;
    const signingUrl = extractSigningUrl(responseData);
    // Public URL of the unsigned agreement PDF (set for WhatsApp dealers). It's
    // also persisted into provider_raw_response via mergeProviderRawResponse, so
    // a later resend can reuse it.
    const unsignedAgreementUrl =
      (responseData as any)?.unsignedAgreementUrl || null;
    const rawStampStatus = extractStampStatus(responseData);
    const stampCertificateIds = extractStampCertificateIds(responseData);
    const stampStatus =
      stampCertificateIds.length > 0
        ? "attached"
        : rawStampStatus || "pending";
    const agreementStatus = extractAgreementStatus(responseData);
    const signerUrls = extractSignerUrls(responseData);

    console.log(
      "[DIGIO INITIATE] extracted providerDocumentId:",
      providerDocumentId
    );
    console.log("[DIGIO INITIATE] extracted requestId:", requestId);
    console.log("[DIGIO INITIATE] extracted signingUrl:", signingUrl);
    console.log("[DIGIO INITIATE] extracted stampStatus:", stampStatus);
    console.log("[DIGIO INITIATE] extracted agreementStatus:", agreementStatus);
    console.log(
      "[DIGIO INITIATE] extracted signerUrls:",
      JSON.stringify(signerUrls, null, 2)
    );
    console.log(
      "[DIGIO INITIATE] extracted stampCertificateIds:",
      JSON.stringify(stampCertificateIds)
    );

    if (!requestId) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Digio agreement was created but requestId could not be extracted.",
          raw: responseData,
        },
        { status: 500 }
      );
    }

    await db
      .update(dealerOnboardingApplications)
      .set({
        agreement_status:
          agreementStatus === "requested"
            ? "sent_to_external_party"
            : agreementStatus,
        review_status: "pending_admin_review",
        completion_status: "pending",
        provider_document_id: providerDocumentId || null,
        request_id: requestId,
        provider_signing_url: signingUrl || null,
        provider_raw_response: mergeProviderRawResponse(
          application.provider_raw_response,
          responseData,
        ),
        stamp_status: stampStatus,
        stamp_certificate_ids: stampCertificateIds,
        last_action_timestamp: new Date(),
        updated_at: new Date(),
      })
      .where(eq(dealerOnboardingApplications.id, dealerId));

    await db
      .delete(dealerAgreementSigners)
      .where(eq(dealerAgreementSigners.application_id, dealerId));

    const findSignerByEmail = (email: string | null) => {
      if (!email) return null;

      return signerUrls.find((item: any) => {
        const itemEmail = String(
          item?.email ||
            item?.signer_email ||
            item?.identifier ||
            item?.signerIdentifier ||
            ""
        )
          .trim()
          .toLowerCase();

        return itemEmail === email.trim().toLowerCase();
      });
    };

    const dealerSignerRaw = findSignerByEmail(dealerSigner.email || null);
    const itarangSigner1Raw = findSignerByEmail(itarangSigner1.email || null);
    const itarangSigner2Raw = itarangSigner2
      ? findSignerByEmail(itarangSigner2.email || null)
      : null;

    const signerInsertRows = [
      {
        applicationId: dealerId,
        providerDocumentId: providerDocumentId || null,
        requestId,
        signerRole: "dealer",
        signerName: dealerSigner.name || "",
        signerEmail: dealerSigner.email || null,
        signerMobile: dealerSigner.mobile || null,
        signingMethod: dealerSigner.signingMethod || null,
        providerSignerIdentifier:
          dealerSigner.email || dealerSigner.mobile || null,
        providerSigningUrl: getSignerUrl(dealerSignerRaw) || signingUrl || null,
        signerStatus: normalizeSignerStatus(dealerSignerRaw?.status),
        providerRawResponse: dealerSignerRaw || {},
      },
      {
        applicationId: dealerId,
        providerDocumentId: providerDocumentId || null,
        requestId,
        signerRole: "itarang_signatory_1",
        signerName: itarangSigner1.name || "",
        signerEmail: itarangSigner1.email || null,
        signerMobile: itarangSigner1.mobile || null,
        signingMethod: itarangSigner1.signingMethod || null,
        providerSignerIdentifier:
          itarangSigner1.email || itarangSigner1.mobile || null,
        providerSigningUrl: getSignerUrl(itarangSigner1Raw),
        signerStatus: normalizeSignerStatus(itarangSigner1Raw?.status),
        providerRawResponse: itarangSigner1Raw || {},
      },
    ];

    if (itarangSigner2) {
      signerInsertRows.push({
        applicationId: dealerId,
        providerDocumentId: providerDocumentId || null,
        requestId,
        signerRole: "itarang_signatory_2",
        signerName: itarangSigner2.name || "",
        signerEmail: itarangSigner2.email || null,
        signerMobile: itarangSigner2.mobile || null,
        signingMethod: itarangSigner2.signingMethod || null,
        providerSignerIdentifier:
          itarangSigner2.email || itarangSigner2.mobile || null,
        providerSigningUrl: getSignerUrl(itarangSigner2Raw),
        signerStatus: normalizeSignerStatus(itarangSigner2Raw?.status),
        providerRawResponse: itarangSigner2Raw || {},
      });
    }

    await insertAgreementSigners(signerInsertRows);

    await insertAgreementEvent({
      applicationId: dealerId,
      providerDocumentId: providerDocumentId || null,
      requestId,
      eventType: "initiated",
      eventStatus:
        agreementStatus === "requested"
          ? "sent_to_external_party"
          : agreementStatus,
      eventPayload: responseData,
    });

    // WhatsApp-onboarded dealers receive their sign link over WhatsApp (their
    // primary channel); the iTarang signer is notified by Digio email. This is a
    // best-effort send — a WhatsApp failure must not fail the whole initiation.
    const whatsappDelivery: {
      attempted: boolean;
      ok: boolean;
      error?: string | null;
    } = { attempted: false, ok: false, error: null };

    const dealerSigningUrl =
      getSignerUrl(dealerSignerRaw) || signingUrl || null;

    if (isWhatsappDealer && application.wa_phone && dealerSigningUrl) {
      whatsappDelivery.attempted = true;
      try {
        const adapter = getAdapter();

        // Log helper — append an outbound send to whatsapp_messages (best-effort).
        const logSend = async (
          messageType: "document" | "text",
          textBody: string,
          res: { ok: boolean; providerMessageId: string | null; raw?: unknown },
        ) => {
          if (!application.wa_session_id) return;
          await db.insert(whatsappMessages).values({
            session_id: application.wa_session_id,
            provider_message_id: res.providerMessageId,
            direction: "outbound",
            message_type: messageType,
            text_body: textBody,
            delivery_status: res.ok ? "sent" : "failed",
            raw_payload: (res.raw ?? null) as any,
          });
        };

        const linkMessage =
          `Hi ${dealerSigner.name}, please review your iTarang dealer agreement ` +
          `above, then *tap the link below to e-sign* it:\n\n${dealerSigningUrl}\n\n` +
          `This link is unique to you. Reply here if you need any help.`;

        if (unsignedAgreementUrl) {
          // Send the actual agreement PDF as a document, then the sign link as a
          // follow-up message so it renders as a tappable link.
          const docRes = await adapter.sendDocument(
            application.wa_phone,
            unsignedAgreementUrl,
            "iTarang-Dealer-Agreement.pdf",
            "📄 Your iTarang dealer agreement — please review it, then tap the link in the next message to e-sign.",
          );
          await logSend("document", "iTarang-Dealer-Agreement.pdf", docRes);

          const linkRes = await adapter.sendText(application.wa_phone, linkMessage);
          await logSend("text", linkMessage, linkRes);

          whatsappDelivery.ok = docRes.ok && linkRes.ok;
          whatsappDelivery.error = docRes.error ?? linkRes.error ?? null;
          if (!whatsappDelivery.ok) {
            console.error("[INITIATE] WhatsApp agreement doc/link send failed:", {
              doc: docRes.error,
              link: linkRes.error,
            });
          }
        } else {
          // Fallback (no stored PDF) — single link message, as before.
          const message =
            `📄 *Your dealer agreement is ready to sign.*\n\n` +
            `Hi ${dealerSigner.name}, please review and sign your iTarang dealer ` +
            `agreement using your secure link below:\n\n${dealerSigningUrl}\n\n` +
            `This link is unique to you. Reply here if you need any help.`;
          const sendRes = await adapter.sendText(application.wa_phone, message);
          await logSend("text", message, sendRes);
          whatsappDelivery.ok = sendRes.ok;
          whatsappDelivery.error = sendRes.error ?? null;
          if (!sendRes.ok) {
            console.error("[INITIATE] WhatsApp agreement send failed:", sendRes.error);
          }
        }
      } catch (waErr: any) {
        whatsappDelivery.error = waErr?.message || "whatsapp_send_error";
        console.error("[INITIATE] WhatsApp agreement send threw:", waErr);
      }
    }

    return NextResponse.json({
      success: true,
      message: whatsappDelivery.attempted
        ? whatsappDelivery.ok
          ? "Agreement initiated. Sign link sent to the dealer on WhatsApp; the iTarang signer was notified by email."
          : "Agreement initiated and the iTarang signer was emailed, but the dealer's WhatsApp sign link could not be delivered (their 24-hour window may be closed). Use the Open Link action to share it manually."
        : "Agreement initiated successfully",
      whatsappDelivery,
      data: {
        ...responseData,
        requestId,
        providerDocumentId: providerDocumentId || null,
        providerSigningUrl: signingUrl || null,
        agreementStatus,
      },
    });
  } catch (error: any) {
    console.error("INITIATE AGREEMENT ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Failed to initiate agreement",
      },
      { status: 500 }
    );
  }
}