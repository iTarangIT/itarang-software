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

  return "electronic_signature";
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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ dealerId: string }> }
) {
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
      reason: "Dealer Signatory",
      signingMethod: agreement.dealerSigningMethod,
    });

    const financierSigner = buildSigner({
      name: agreement.financierSignatory?.name,
      email: agreement.financierSignatory?.email,
      mobile: agreement.financierSignatory?.mobile,
      reason: "Financier Signatory",
      signingMethod: agreement.financierSignatory?.signingMethod,
    });

    const itarangSigner1 = buildSigner({
      name: agreement.itarangSignatory1?.name,
      email: agreement.itarangSignatory1?.email,
      mobile: agreement.itarangSignatory1?.mobile,
      reason: "iTarang Signatory 1",
      signingMethod: agreement.itarangSignatory1?.signingMethod,
    });

    const itarangSigner2 = buildSigner({
      name: agreement.itarangSignatory2?.name,
      email: agreement.itarangSignatory2?.email,
      mobile: agreement.itarangSignatory2?.mobile,
      reason: "iTarang Signatory 2",
      signingMethod: agreement.itarangSignatory2?.signingMethod,
    });

    const signers = [
      dealerSigner,
      financierSigner,
      itarangSigner1,
      itarangSigner2,
    ].filter(Boolean);

    console.log("Dealer Signer:", dealerSigner);
    console.log("Financier Signer:", financierSigner);
    console.log("iTarang Signer 1:", itarangSigner1);
    console.log("iTarang Signer 2:", itarangSigner2);
    console.log("Final Signers:", signers);

    if (signers.length !== 4) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Incomplete agreement signatory data. Dealer, financier, and both iTarang signers must have valid name, email, and phone.",
          debug: {
            dealerSigner,
            financierSigner,
            itarangSigner1,
            itarangSigner2,
          },
        },
        { status: 400 }
      );
    }

    const appBaseUrl =
      process.env.APP_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      "http://localhost:3000";

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
      agreement: {
        agreementName:
          cleanString(agreement.agreementName) ||
          "Dealer Finance Enablement Agreement",
        agreementVersion: cleanString(agreement.agreementVersion) || "v1.0",
        dateOfSigning: cleanString(agreement.dateOfSigning),
        mouDate: cleanString(agreement.mouDate),
        financierName: cleanString(agreement.financierName),
        dealerSignerName: cleanString(agreement.dealerSignerName),
        dealerSignerDesignation: cleanString(agreement.dealerSignerDesignation),
        dealerSignerEmail: cleanString(agreement.dealerSignerEmail),
        dealerSignerPhone: normalizePhone(agreement.dealerSignerPhone),
        dealerSigningMethod:
          cleanString(agreement.dealerSigningMethod) || "electronic_signature",
        financierSignatory: agreement.financierSignatory || null,
        itarangSignatory1: agreement.itarangSignatory1 || null,
        itarangSignatory2: agreement.itarangSignatory2 || null,
        signingOrder: agreement.signingOrder || [
          "dealer",
          "financier",
          "itarang_1",
          "itarang_2",
        ],
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

    const digioResponse = await fetch(
      `${appBaseUrl}/api/integrations/digio/create-agreement`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(createAgreementPayload),
      }
    );

    let digioJson: any = null;
    try {
      digioJson = await digioResponse.json();
    } catch {
      digioJson = null;
    }

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

    const providerDocumentId = digioJson?.data?.providerDocumentId || null;
    const requestId = digioJson?.data?.requestId || null;
    const signingUrl = digioJson?.data?.signingUrl || null;

    await db
      .update(dealerOnboardingApplications)
      .set({
        agreementStatus: "sent_to_external_party",
        reviewStatus: "pending_admin_review",
        completionStatus: "pending",
        providerDocumentId,
        requestId,
        providerSigningUrl: signingUrl,
        providerRawResponse: digioJson?.data || {},
        stampStatus: digioJson?.data?.stampStatus || "pending",
        agreementLastInitiatedAt: new Date(),
        lastActionTimestamp: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(dealerOnboardingApplications.id, dealerId));

    await db
      .delete(dealerAgreementSigners)
      .where(eq(dealerAgreementSigners.applicationId, dealerId));

    const signerUrls = Array.isArray(digioJson?.data?.signerUrls)
      ? digioJson.data.signerUrls
      : [];

    const findSignerUrlByEmail = (email: string | null) => {
      if (!email) return null;

      return signerUrls.find(
        (item: any) =>
          String(item?.email || "")
            .trim()
            .toLowerCase() === email.trim().toLowerCase()
      );
    };

    await insertAgreementSigners([
      {
        applicationId: dealerId,
        providerDocumentId,
        requestId,
        signerRole: "dealer",
        signerName: dealerSigner?.name || "",
        signerEmail: dealerSigner?.email || null,
        signerMobile: dealerSigner?.mobile || null,
        signingMethod: dealerSigner?.signingMethod || null,
        providerSignerIdentifier:
          dealerSigner?.email || dealerSigner?.mobile || null,
        providerSigningUrl:
          findSignerUrlByEmail(dealerSigner?.email || null)?.authenticationUrl ||
          null,
        signerStatus: "sent",
        providerRawResponse:
          findSignerUrlByEmail(dealerSigner?.email || null) || {},
      },
      {
        applicationId: dealerId,
        providerDocumentId,
        requestId,
        signerRole: "financier",
        signerName: financierSigner?.name || "",
        signerEmail: financierSigner?.email || null,
        signerMobile: financierSigner?.mobile || null,
        signingMethod: financierSigner?.signingMethod || null,
        providerSignerIdentifier:
          financierSigner?.email || financierSigner?.mobile || null,
        providerSigningUrl:
          findSignerUrlByEmail(financierSigner?.email || null)
            ?.authenticationUrl || null,
        signerStatus: "sent",
        providerRawResponse:
          findSignerUrlByEmail(financierSigner?.email || null) || {},
      },
      {
        applicationId: dealerId,
        providerDocumentId,
        requestId,
        signerRole: "itarang_signatory_1",
        signerName: itarangSigner1?.name || "",
        signerEmail: itarangSigner1?.email || null,
        signerMobile: itarangSigner1?.mobile || null,
        signingMethod: itarangSigner1?.signingMethod || null,
        providerSignerIdentifier:
          itarangSigner1?.email || itarangSigner1?.mobile || null,
        providerSigningUrl:
          findSignerUrlByEmail(itarangSigner1?.email || null)
            ?.authenticationUrl || null,
        signerStatus: "sent",
        providerRawResponse:
          findSignerUrlByEmail(itarangSigner1?.email || null) || {},
      },
      {
        applicationId: dealerId,
        providerDocumentId,
        requestId,
        signerRole: "itarang_signatory_2",
        signerName: itarangSigner2?.name || "",
        signerEmail: itarangSigner2?.email || null,
        signerMobile: itarangSigner2?.mobile || null,
        signingMethod: itarangSigner2?.signingMethod || null,
        providerSignerIdentifier:
          itarangSigner2?.email || itarangSigner2?.mobile || null,
        providerSigningUrl:
          findSignerUrlByEmail(itarangSigner2?.email || null)
            ?.authenticationUrl || null,
        signerStatus: "sent",
        providerRawResponse:
          findSignerUrlByEmail(itarangSigner2?.email || null) || {},
      },
    ]);

    await insertAgreementEvent({
      applicationId: dealerId,
      providerDocumentId,
      requestId,
      eventType: "initiated",
      eventStatus: "sent_to_external_party",
      eventPayload: digioJson?.data || {},
    });

    return NextResponse.json({
      success: true,
      message: "Agreement initiated successfully",
      data: digioJson?.data || null,
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