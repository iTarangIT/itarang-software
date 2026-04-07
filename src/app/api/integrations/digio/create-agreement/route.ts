import { NextRequest, NextResponse } from "next/server";
import puppeteer from "puppeteer";
import { buildTarangDealerAgreementHtml } from "@/lib/agreement/dealer-agreement-template";

type AgreementPayload = {
  company?: any;
  ownership?: any;
  agreement?: any;
};

type SignerItem = {
  identifier: string;
  name: string;
  reason: string;
  sign_type: string;
};

function cleanEnv(value?: string) {
  return value?.trim().replace(/^[\"']|[\"']$/g, "");
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

async function renderPdfFromHtml(html: string) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "14mm",
        right: "12mm",
        bottom: "14mm",
        left: "12mm",
      },
    });

    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

function normalizeDigioAgreementStatus(parsed: any) {
  const digioStatus = String(
    parsed?.agreement_status || parsed?.status || ""
  )
    .trim()
    .toLowerCase();

  if (digioStatus === "completed" || digioStatus === "signed") {
    return "completed";
  }

  if (digioStatus === "partially_signed" || digioStatus === "partial") {
    return "partially_signed";
  }

  return "sent_for_signature";
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as AgreementPayload;

    const clientId = cleanEnv(process.env.DIGIO_CLIENT_ID);
    const clientSecret = cleanEnv(process.env.DIGIO_CLIENT_SECRET);
    const baseUrl =
      cleanEnv(process.env.DIGIO_BASE_URL) || "https://ext.digio.in:444";

    if (!clientId || !clientSecret) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Missing Digio configuration. Set DIGIO_CLIENT_ID and DIGIO_CLIENT_SECRET.",
        },
        { status: 500 }
      );
    }

    const agreement = body.agreement || {};
    const company = body.company || {};
    const ownership = body.ownership || {};

    const dealerSigner = buildSigner(
      agreement.dealerSignerEmail,
      agreement.dealerSignerPhone,
      agreement.dealerSignerName,
      "dealer signer",
      agreement.dealerSigningMethod
    );

    const itarangSigner1 = buildSigner(
      agreement.itarangSignatory1?.email,
      agreement.itarangSignatory1?.mobile,
      agreement.itarangSignatory1?.name,
      "iTarang signer 1",
      agreement.itarangSignatory1?.signingMethod
    );

    const itarangSigner2 = buildSigner(
      agreement.itarangSignatory2?.email,
      agreement.itarangSignatory2?.mobile,
      agreement.itarangSignatory2?.name,
      "iTarang signer 2",
      agreement.itarangSignatory2?.signingMethod
    );

    if (!dealerSigner || !itarangSigner1) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Dealer and iTarang Signer 1 are required with valid details.",
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
            "iTarang Signer 2 is optional but must be fully valid if provided.",
        },
        { status: 400 }
      );
    }

    const signers: SignerItem[] = [dealerSigner, itarangSigner1];

    if (itarangSigner2) {
      signers.push(itarangSigner2);
    }

    const duplicates = findDuplicateIdentifiers(signers);
    if (duplicates.length > 0) {
      return NextResponse.json(
        {
          success: false,
          message: `Duplicate signer identifiers: ${duplicates.join(", ")}`,
        },
        { status: 400 }
      );
    }

    // Use the signing method configured per signer (aadhaar, electronic, or dsc)
    const digioSigners = signers.map(s => ({
      identifier: s.identifier,
      name: s.name,
      reason: s.reason,
      sign_type: s.sign_type,
    }));

    // Generate agreement PDF from HTML template
    const html = buildTarangDealerAgreementHtml({
      company: {
        companyName: company.companyName || "",
        companyAddress: company.companyAddress || "",
        companyType: company.companyType || "",
        gstNumber: company.gstNumber || "",
        companyPanNumber: company.companyPanNumber || company.panNumber || "",
        companyCity: company.companyCity || "",
        companyDistrict: company.companyDistrict || "",
        companyState: company.companyState || "",
        companyPinCode: company.companyPinCode || "",
      },
      ownership: {
        ownerName: ownership.ownerName || "",
        ownerPhone: ownership.ownerPhone || "",
        ownerEmail: ownership.ownerEmail || "",
        ownerAge: "",
        ownerAddressLine1:
          typeof ownership.businessAddress === "object" &&
            ownership.businessAddress &&
            "address" in ownership.businessAddress
            ? String((ownership.businessAddress as any).address || "")
            : "",
        ownerCity:
          typeof ownership.businessAddress === "object" &&
            ownership.businessAddress &&
            "city" in ownership.businessAddress
            ? String((ownership.businessAddress as any).city || "")
            : "",
        ownerDistrict: "",
        ownerState:
          typeof ownership.businessAddress === "object" &&
            ownership.businessAddress &&
            "state" in ownership.businessAddress
            ? String((ownership.businessAddress as any).state || "")
            : "",
        ownerPinCode:
          typeof ownership.businessAddress === "object" &&
            ownership.businessAddress &&
            "pincode" in ownership.businessAddress
            ? String((ownership.businessAddress as any).pincode || "")
            : "",
        bankName: ownership.bankName || "",
        accountNumber: ownership.accountNumber || "",
        ifsc: ownership.ifscCode || "",
        beneficiaryName: ownership.beneficiaryName || "",
        branch: "",
        accountType: "",
      },
      agreement: {
        dateOfSigning: agreement.dateOfSigning || "",
        executionPlace: agreement.executionPlace || "",
        dealerSignerName: agreement.dealerSignerName || "",
        dealerSignerDesignation: agreement.dealerSignerDesignation || "",
        dealerSignerEmail: agreement.dealerSignerEmail || "",
        dealerSignerPhone: agreement.dealerSignerPhone || "",
        financierName: "",
        financerLegalEntityName: "",
        vehicleType: agreement.vehicleType || "",
        manufacturer: agreement.manufacturer || "",
        brand: agreement.brand || "",
        statePresence: agreement.statePresence || "",
        itarangSignatory1: agreement.itarangSignatory1 || null,
        itarangSignatory2: itarangSigner2 ? agreement.itarangSignatory2 || null : null,
      },
    });

    console.log("DIGIO DEBUG -> Rendering PDF with Puppeteer...");
    const pdfBuffer = await renderPdfFromHtml(html);
    const agreementBase64 = pdfBuffer.toString("base64");
    console.log("DIGIO DEBUG -> PDF generated, size:", pdfBuffer.length, "bytes");

    const digioPayload = {
      file_name: `${cleanString(company.companyName) || "dealer"}-agreement.pdf`,
      file_data: agreementBase64,
      expire_in_days: 5,
      notify_signers: true,
      send_sign_link: true,
      include_authentication_url: true,
      sequential: true,
      signers: digioSigners,
    };

    const requestUrl = `${baseUrl}/v2/client/document/uploadpdf`;

    console.log("DIGIO DEBUG -> REQUEST URL:", requestUrl);
    console.log("DIGIO DEBUG -> SIGNERS:", digioSigners);

    const digioResponse = await fetch(requestUrl, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(clientId, clientSecret),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(digioPayload),
      cache: "no-store",
    });

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

    const signingParties = Array.isArray(parsed?.signing_parties)
      ? parsed.signing_parties
      : [];

    const dealerParty =
      signingParties.find(
        (party: any) =>
          String(party?.reason || "").toLowerCase() === "dealer signer"
      ) || signingParties[0];

    const signingUrl =
      dealerParty?.authentication_url ||
      parsed?.signing_url ||
      parsed?.sign_url ||
      parsed?.redirect_url ||
      parsed?.authentication_url ||
      "";

    const normalizedStatus = normalizeDigioAgreementStatus(parsed);

    return NextResponse.json({
      success: true,
      data: {
        requestId: parsed?.id || parsed?.request_id || "",
        providerDocumentId: parsed?.document_id || parsed?.documentId || "",
        signingUrl,
        signerUrls: signingParties.map((party: any) => ({
          name: party?.name || "",
          reason: party?.reason || "",
          identifier: party?.identifier || "",
          authenticationUrl: party?.authentication_url || "",
          status: party?.status || "",
        })),
        status: normalizedStatus,
        rawResponse: rawText,
      },
    });
  } catch (error) {
    console.error("DIGIO CREATE AGREEMENT ERROR", error);

    return NextResponse.json(
      {
        success: false,
        message: error instanceof Error ? error.message : "Unexpected server error while creating Digio agreement.",
      },
      { status: 500 }
    );
  }
}