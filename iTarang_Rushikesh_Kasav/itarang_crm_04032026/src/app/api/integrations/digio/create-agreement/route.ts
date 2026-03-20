import { NextRequest, NextResponse } from "next/server";

type AgreementPayload = {
  agreement?: {
    dateOfSigning?: string;
    expiryDays?: number;
    dealerSignerName?: string;
    dealerSignerEmail?: string;
    dealerSignerPhone?: string;
    dealerSigningMethod?: string;
    financierName?: string;
    sequenceMode?: "sequential" | "parallel";
    itarangSignatory1?: {
      name?: string;
      email?: string;
      mobile?: string;
      signingMethod?: string;
    };
    itarangSignatory2?: {
      name?: string;
      email?: string;
      mobile?: string;
      signingMethod?: string;
    };
    financierSignatory?: {
      name?: string;
      email?: string;
      mobile?: string;
      address?: string;
      signingMethod?: string;
    };
    includeWitnessesInSigning?: boolean;
    witness1?: {
      name?: string;
      email?: string;
      mobile?: string;
      address?: string;
      signingMethod?: string;
    };
    witness2?: {
      name?: string;
      email?: string;
      mobile?: string;
      address?: string;
      signingMethod?: string;
    };
  };
  company?: {
    companyName?: string;
  };
};

type SignerItem = {
  identifier: string;
  name: string;
  reason: string;
  sign_type: string;
};

function cleanEnv(value?: string) {
  return value?.trim().replace(/^["']|["']$/g, "");
}

function cleanString(value?: string) {
  return (value || "").trim();
}

function cleanPhone(value?: string) {
  return (value || "").replace(/\D/g, "");
}

function isValidEmail(value?: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanString(value));
}

function isValidPhone(value?: string) {
  return /^[6-9]\d{9}$/.test(cleanPhone(value));
}

function basicAuthHeader(clientId: string, clientSecret: string) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

function mapSigningMethod(method?: string) {
  switch (method) {
    case "aadhaar_esign":
      return "aadhaar";
    case "dsc_signature":
      return "dsc";
    case "electronic_signature":
    default:
      return "electronic";
  }
}

function buildSigner(
  email: string | undefined,
  mobile: string | undefined,
  name: string | undefined,
  reason: string,
  signingMethod?: string
): SignerItem | null {
  const cleanedName = cleanString(name);
  const cleanedEmail = cleanString(email).toLowerCase();
  const cleanedMobile = cleanPhone(mobile);

  if (!cleanedName) return null;

  const identifier = isValidEmail(cleanedEmail)
    ? cleanedEmail
    : isValidPhone(cleanedMobile)
    ? cleanedMobile
    : "";

  if (!identifier) return null;

  return {
    identifier,
    name: cleanedName,
    reason,
    sign_type: mapSigningMethod(signingMethod),
  };
}

function findDuplicateIdentifiers(signers: SignerItem[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const signer of signers) {
    if (seen.has(signer.identifier)) {
      duplicates.add(signer.identifier);
    }
    seen.add(signer.identifier);
  }

  return Array.from(duplicates);
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as AgreementPayload;

    const clientId = cleanEnv(process.env.DIGIO_CLIENT_ID);
    const clientSecret = cleanEnv(process.env.DIGIO_CLIENT_SECRET);
    const templateId =
      cleanEnv(process.env.DIGIO_TEMPLATE_ID) ||
      cleanEnv(process.env.DIGIO_TEMPLATE_ID_DEALER_FINANCE);
    const baseUrl =
      cleanEnv(process.env.DIGIO_BASE_URL) || "https://ext.digio.in:444";

    console.log("DIGIO DEBUG -> BASE_URL:", baseUrl);
    console.log("DIGIO DEBUG -> CLIENT_ID:", clientId || "MISSING");
    console.log(
      "DIGIO DEBUG -> CLIENT_SECRET:",
      clientSecret ? "PRESENT" : "MISSING"
    );
    console.log("DIGIO DEBUG -> TEMPLATE_ID:", templateId || "MISSING");

    if (!clientId || !clientSecret || !templateId) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Missing Digio configuration. Set DIGIO_CLIENT_ID, DIGIO_CLIENT_SECRET, and DIGIO_TEMPLATE_ID.",
        },
        { status: 500 }
      );
    }

    const agreement = body.agreement;
    const company = body.company;

    if (!agreement) {
      return NextResponse.json(
        {
          success: false,
          message: "Agreement payload is missing.",
        },
        { status: 400 }
      );
    }

    const dealerSigner = buildSigner(
      agreement.dealerSignerEmail,
      agreement.dealerSignerPhone,
      agreement.dealerSignerName,
      "Dealer Signatory",
      agreement.dealerSigningMethod
    );

    const financierSigner = buildSigner(
      agreement.financierSignatory?.email,
      agreement.financierSignatory?.mobile,
      agreement.financierSignatory?.name,
      "Financier Signatory",
      agreement.financierSignatory?.signingMethod
    );

    const itarangSigner1 = buildSigner(
      agreement.itarangSignatory1?.email,
      agreement.itarangSignatory1?.mobile,
      agreement.itarangSignatory1?.name,
      "iTarang Signatory 1",
      agreement.itarangSignatory1?.signingMethod
    );

    const itarangSigner2 = buildSigner(
      agreement.itarangSignatory2?.email,
      agreement.itarangSignatory2?.mobile,
      agreement.itarangSignatory2?.name,
      "iTarang Signatory 2",
      agreement.itarangSignatory2?.signingMethod
    );

    const witnessSigner1 =
      agreement.includeWitnessesInSigning
        ? buildSigner(
            agreement.witness1?.email,
            agreement.witness1?.mobile,
            agreement.witness1?.name,
            "Witness 1",
            agreement.witness1?.signingMethod
          )
        : null;

    const witnessSigner2 =
      agreement.includeWitnessesInSigning
        ? buildSigner(
            agreement.witness2?.email,
            agreement.witness2?.mobile,
            agreement.witness2?.name,
            "Witness 2",
            agreement.witness2?.signingMethod
          )
        : null;

    const signers = [
      dealerSigner,
      financierSigner,
      itarangSigner1,
      itarangSigner2,
      witnessSigner1,
      witnessSigner2,
    ].filter(Boolean) as SignerItem[];

    console.log("DIGIO DEBUG -> AGREEMENT:", agreement);
    console.log("DIGIO DEBUG -> SIGNERS:", signers);

    if (!dealerSigner) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Dealer signatory is invalid. Please provide valid dealer signer name and a valid email or mobile number.",
        },
        { status: 400 }
      );
    }

    if (!financierSigner) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Financier signatory is invalid. Please provide valid financier signer name and a valid email or mobile number.",
        },
        { status: 400 }
      );
    }

    if (!itarangSigner1 || !itarangSigner2) {
      return NextResponse.json(
        {
          success: false,
          message:
            "iTarang signatories are invalid. Please provide valid names and valid email or mobile for both signatories.",
        },
        { status: 400 }
      );
    }

    if (agreement.includeWitnessesInSigning && (!witnessSigner1 || !witnessSigner2)) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Witness details are invalid. Please provide valid names and valid email or mobile numbers for both witnesses.",
        },
        { status: 400 }
      );
    }

    const duplicateIdentifiers = findDuplicateIdentifiers(signers);

    if (duplicateIdentifiers.length > 0) {
      return NextResponse.json(
        {
          success: false,
          message: `Duplicate signer email/mobile found: ${duplicateIdentifiers.join(
            ", "
          )}. Each signer must use a unique email or mobile.`,
        },
        { status: 400 }
      );
    }

    const payload = {
      file_name: `${cleanString(company?.companyName) || "dealer"}-agreement`,
      template_id: templateId,
      expire_in_days: agreement.expiryDays || 7,
      send_sign_link: true,
      notify_signers: true,
      signers,
      template_values: {
        dealer_company_name: cleanString(company?.companyName),
        dealer_signer_name: cleanString(agreement.dealerSignerName),
        dealer_signer_email: cleanString(agreement.dealerSignerEmail),
        dealer_signer_phone: cleanPhone(agreement.dealerSignerPhone),
        financier_name: cleanString(agreement.financierName),
        agreement_date: cleanString(agreement.dateOfSigning),
      },
    };

    console.log(
      "DIGIO DEBUG -> REQUEST URL:",
      `${baseUrl}/v2/client/template/create_sign_request`
    );
    console.log("DIGIO DEBUG -> PAYLOAD:", JSON.stringify(payload, null, 2));

    const digioResponse = await fetch(
      `${baseUrl}/v2/client/template/create_sign_request`,
      {
        method: "POST",
        headers: {
          Authorization: basicAuthHeader(clientId, clientSecret),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
      }
    );

    const rawText = await digioResponse.text();

    console.log("DIGIO DEBUG -> STATUS:", digioResponse.status);
    console.log("DIGIO DEBUG -> RAW RESPONSE:", rawText);

    let parsed: any = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }

    if (!digioResponse.ok) {
      return NextResponse.json(
        {
          success: false,
          message:
            parsed?.message ||
            parsed?.error_msg ||
            parsed?.error ||
            "Digio request failed",
          raw: parsed || rawText,
        },
        { status: digioResponse.status }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        requestId:
          parsed?.id ||
          parsed?.request_id ||
          parsed?.document_id ||
          parsed?.documentId ||
          "",
        providerDocumentId:
          parsed?.document_id ||
          parsed?.documentId ||
          parsed?.id ||
          "",
        signingUrl:
          parsed?.signing_url ||
          parsed?.sign_url ||
          parsed?.redirect_url ||
          parsed?.signers?.[0]?.sign_url ||
          "",
        status:
          parsed?.status?.toLowerCase?.() === "completed"
            ? "completed"
            : "sent_for_signature",
        rawResponse: rawText,
      },
    });
  } catch (error) {
    console.error("DIGIO CREATE AGREEMENT ERROR", error);

    return NextResponse.json(
      {
        success: false,
        message: "Unexpected server error while creating Digio agreement.",
      },
      { status: 500 }
    );
  }
}