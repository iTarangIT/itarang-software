import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import {
  dealerAgreementSigners,
  dealerOnboardingApplications,
} from "@/lib/db/schema";
import {
  insertAgreementEvent,
  insertAgreementSigners,
} from "@/lib/agreement/tracking";
import { mergeProviderRawResponse } from "@/lib/agreement/providerRaw";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
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

    if (!application.financeEnabled) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Agreement can only be initiated for finance-enabled applications.",
        },
        { status: 400 }
      );
    }

    const currentAgreementStatus = String(
      application.agreementStatus || ""
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

    const dealerSigner = buildSigner({
      name: agreement.dealerSignerName,
      email: agreement.dealerSignerEmail,
      mobile: agreement.dealerSignerPhone,
      reason: "dealer signer",
      signingMethod: agreement.dealerSigningMethod || "aadhaar_esign",
    });

    const itarangSigner1 = buildSigner({
      name: agreement.itarangSignatory1?.name,
      email: agreement.itarangSignatory1?.email,
      mobile: agreement.itarangSignatory1?.mobile,
      reason: "iTarang signer 1",
      signingMethod: agreement.itarangSignatory1?.signingMethod || "aadhaar_esign",
    });

    const itarangSigner2 = buildSigner({
      name: agreement.itarangSignatory2?.name,
      email: agreement.itarangSignatory2?.email,
      mobile: agreement.itarangSignatory2?.mobile,
      reason: "iTarang signer 2",
      signingMethod: agreement.itarangSignatory2?.signingMethod || "aadhaar_esign",
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
      !!agreement.itarangSignatory2?.name ||
      !!agreement.itarangSignatory2?.email ||
      !!agreement.itarangSignatory2?.mobile;

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
        companyName: application.companyName || "",
        companyType: application.companyType || "",
        companyAddress:
          typeof application.businessAddress === "object" &&
          application.businessAddress &&
          "address" in application.businessAddress
            ? String((application.businessAddress as any).address || "")
            : "",
        gstNumber: application.gstNumber || "",
        panNumber: application.panNumber || "",
      },
      ownership: {
        ownerName: application.ownerName || "",
        ownerPhone: application.ownerPhone || "",
        ownerEmail: application.ownerEmail || "",
        businessAddress: application.businessAddress || {},
        bankName: application.bankName || "",
        accountNumber: application.accountNumber || "",
        ifscCode: application.ifscCode || "",
        beneficiaryName: application.beneficiaryName || "",
      },
      agreement: {
        agreementName:
          cleanString(agreement.agreementName) ||
          "Dealer Finance Enablement Agreement",
        agreementVersion: cleanString(agreement.agreementVersion) || "v1.0",
        dateOfSigning: cleanString(agreement.dateOfSigning),
        mouDate: cleanString(agreement.mouDate),
        financierName: "",
        dealerSignerName: cleanString(agreement.dealerSignerName),
        dealerSignerDesignation: cleanString(agreement.dealerSignerDesignation),
        dealerSignerEmail: cleanString(agreement.dealerSignerEmail),
        dealerSignerPhone: normalizePhone(agreement.dealerSignerPhone),
        dealerSigningMethod:
          cleanString(agreement.dealerSigningMethod) || "aadhaar_esign",
        financierSignatory: null,
        itarangSignatory1: agreement.itarangSignatory1 || null,
        itarangSignatory2: itarangSigner2 ? agreement.itarangSignatory2 || null : null,
        signingOrder: finalSigningOrder,
        isOemFinancing: !!agreement.isOemFinancing,
        vehicleType: cleanString(agreement.vehicleType),
        manufacturer: cleanString(agreement.manufacturer),
        brand: cleanString(agreement.brand),
        statePresence: cleanString(agreement.statePresence),
        signers,
        sequential: true,
        expireInDays: 5,
      },
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
        agreementStatus:
          agreementStatus === "requested"
            ? "sent_to_external_party"
            : agreementStatus,
        reviewStatus: "pending_admin_review",
        completionStatus: "pending",
        providerDocumentId: providerDocumentId || null,
        requestId,
        providerSigningUrl: signingUrl || null,
        providerRawResponse: mergeProviderRawResponse(
          application.providerRawResponse,
          responseData,
        ),
        stampStatus,
        stampCertificateIds,
        lastActionTimestamp: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(dealerOnboardingApplications.id, dealerId));

    await db
      .delete(dealerAgreementSigners)
      .where(eq(dealerAgreementSigners.applicationId, dealerId));

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

    return NextResponse.json({
      success: true,
      message: "Agreement initiated successfully",
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