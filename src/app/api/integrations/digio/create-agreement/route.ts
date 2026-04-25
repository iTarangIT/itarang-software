import { NextRequest, NextResponse } from "next/server";
import { launchBrowser } from "@/lib/pdf/launch-browser";
import { buildTarangDealerAgreementHtml } from "@/lib/agreement/dealer-agreement-template";
import {
  extractAttachedEstampDetails,
  extractStampCertificateIds,
} from "@/lib/digio/parse-status";

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
    case "electronic_signature":
      return "electronic";
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

/**
 * Count pages in a PDF buffer by matching /Type /Page (not /Pages) entries.
 * Works reliably for Puppeteer-generated PDFs, which use standard structure.
 */
function countPdfPages(pdf: Buffer): number {
  const content = pdf.toString("latin1");
  const matches = content.match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  return matches && matches.length > 0 ? matches.length : 1;
}

/**
 * Build explicit sign coordinates for a single signer across every page of the
 * final stamped document. Page 1 (the DigiO-prepended e-stamp) gets coords in
 * the empty middle area of the stamp certificate, so signatures don't overlap
 * the "Statutory Alert:" text at the bottom. Pages 2..N (the agreement pages)
 * get standard footer coords.
 *
 * Coordinate system: DigiO uses top-left origin on an A4 canvas (~595 x 842 pt).
 */
function buildSignerCoordinatesList(
  signerIndex: number,
  agreementPageCount: number,
  estampEnabled: boolean,
) {
  const xPositions = [70, 230, 390];
  const x = xPositions[signerIndex] ?? 70 + signerIndex * 160;
  const w = 140;

  const coords: Array<{ page_no: number; x: number; y: number; w: number; h: number }> = [];

  const agreementStartPage = estampEnabled ? 2 : 1;
  const totalPages = estampEnabled ? agreementPageCount + 1 : agreementPageCount;

  if (estampEnabled) {
    coords.push({ page_no: 1, x, y: 600, w, h: 50 });
  }

  for (let p = agreementStartPage; p <= totalPages; p++) {
    coords.push({ page_no: p, x, y: 780, w, h: 40 });
  }

  return coords;
}

async function renderPdfFromHtml(html: string) {
  const browser = await launchBrowser();

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

    const estampEnabled =
      cleanEnv(process.env.DIGIO_ESTAMP_ENABLED) === "true";
    const estampTag =
      cleanEnv(process.env.DIGIO_ESTAMP_TAG) || "KA-100-General";
    const estampQuantity =
      Number(cleanEnv(process.env.DIGIO_ESTAMP_QUANTITY)) || 1;

    const agreementPageCount = countPdfPages(pdfBuffer);
    console.log(
      "DIGIO DEBUG -> agreement PDF page count:",
      agreementPageCount,
      "| stamp prepended:",
      estampEnabled,
    );

    // Use the signing method configured per signer (aadhaar, electronic, or dsc),
    // with explicit per-page sign_coordinates so DigiO places signatures in the
    // empty middle area of the e-stamp (page 1) instead of overlapping the
    // Statutory Alert text, while keeping footer placement on agreement pages.
    const digioSigners = signers.map((s, idx) => {
      const coords = buildSignerCoordinatesList(
        idx,
        agreementPageCount,
        estampEnabled,
      );
      return {
        identifier: s.identifier,
        name: s.name,
        reason: s.reason,
        sign_type: s.sign_type,
        sign_coordinates: coords[0],
        ...(coords.length > 1
          ? { additional_sign_coordinates: coords.slice(1) }
          : {}),
      };
    });

    const digioPayload: Record<string, unknown> = {
      file_name: `${cleanString(company.companyName) || "dealer"}-agreement.pdf`,
      file_data: agreementBase64,
      expire_in_days: 5,
      notify_signers: true,
      send_sign_link: true,
      include_authentication_url: true,
      sequential: true,
      signers: digioSigners,
    };

    if (estampEnabled) {
      // sign_on_page is intentionally omitted — signer-level sign_coordinates
      // below control signature placement on every page (including the stamp
      // page 1 in the empty middle area). Setting sign_on_page would risk
      // DigiO double-placing signatures on page 1.
      digioPayload.estamp_request = {
        tags: { [estampTag]: estampQuantity },
        note_content: "",
        note_on_page: "first",
      };
    }

    const requestUrl = `${baseUrl}/v2/client/document/uploadpdf`;

    console.log("DIGIO DEBUG -> REQUEST URL:", requestUrl);
    console.log("DIGIO DEBUG -> SIGNERS:", digioSigners);
    console.log("DIGIO DEBUG -> ESTAMP ENABLED:", estampEnabled);
    if (estampEnabled) {
      console.log(
        "DIGIO DEBUG -> ESTAMP REQUEST:",
        JSON.stringify(digioPayload.estamp_request),
      );
    }

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
    const attachedEstampDetails = extractAttachedEstampDetails(parsed);
    const stampCertificateIds = extractStampCertificateIds(parsed);

    console.log(
      "DIGIO DEBUG -> ATTACHED ESTAMP DETAILS:",
      JSON.stringify(attachedEstampDetails),
    );
    console.log(
      "DIGIO DEBUG -> STAMP CERTIFICATE IDS:",
      JSON.stringify(stampCertificateIds),
    );

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
        attachedEstampDetails,
        stampCertificateIds,
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