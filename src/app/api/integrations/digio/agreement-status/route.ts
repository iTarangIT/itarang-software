import { NextRequest, NextResponse } from "next/server";

function cleanEnv(value?: string) {
  return value?.trim().replace(/^[\"']|[\"']$/g, "");
}

function basicAuthHeader(clientId: string, clientSecret: string) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

function normalizeAgreementStatus(rawStatus?: string) {
  const status = String(rawStatus || "").trim().toLowerCase();

  if (!status) return "sent_for_signature";

  if (
    status === "completed" ||
    status === "executed" ||
    status === "signed" ||
    status === "success"
  ) {
    return "completed";
  }

  if (
    status === "requested" ||
    status === "pending" ||
    status === "created" ||
    status === "sent" ||
    status === "partially_signed" ||
    status === "in_progress"
  ) {
    return "sent_for_signature";
  }

  if (status === "expired") return "expired";

  if (status === "failed" || status === "cancelled" || status === "error") {
    return "failed";
  }

  return "sent_for_signature";
}

function normalizeSignerStatus(rawStatus?: string) {
  const status = String(rawStatus || "").trim().toLowerCase();

  if (!status) return "requested";

  if (
    status === "signed" ||
    status === "completed" ||
    status === "executed" ||
    status === "success"
  ) {
    return "signed";
  }

  if (status === "viewed") return "viewed";
  if (status === "expired") return "expired";
  if (status === "failed" || status === "declined" || status === "rejected") {
    return "failed";
  }

  return status;
}

async function fetchDigioStatus(
  baseUrl: string,
  authHeader: string,
  documentId: string
) {
  const urls = [
    `${baseUrl}/v2/client/document/${encodeURIComponent(documentId)}`,
    `${baseUrl}/v2/client/document/status/${encodeURIComponent(documentId)}`,
  ];

  let lastRaw = "";
  let lastStatus = 500;

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
        cache: "no-store",
      });

      const rawText = await response.text();
      lastRaw = rawText;
      lastStatus = response.status;

      console.log("DIGIO STATUS DEBUG -> URL:", url);
      console.log("DIGIO STATUS DEBUG -> STATUS:", response.status);
      console.log("DIGIO STATUS DEBUG -> RAW RESPONSE:", rawText);

      if (!response.ok) continue;

      let parsed: any = null;
      try {
        parsed = rawText ? JSON.parse(rawText) : null;
      } catch {
        parsed = null;
      }

      if (parsed) {
        return {
          ok: true,
          parsed,
          rawText,
          status: response.status,
          url,
        };
      }
    } catch (error) {
      console.error("DIGIO STATUS DEBUG -> FETCH ERROR:", error);
    }
  }

  return {
    ok: false,
    parsed: null,
    rawText: lastRaw,
    status: lastStatus,
  };
}

export async function GET(req: NextRequest) {
  try {
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

    const { searchParams } = new URL(req.url);
    const requestId = searchParams.get("requestId") || "";
    const providerDocumentId = searchParams.get("providerDocumentId") || "";
    const lookupId = providerDocumentId || requestId;

    if (!lookupId) {
      return NextResponse.json(
        {
          success: false,
          message: "Missing requestId or providerDocumentId.",
        },
        { status: 400 }
      );
    }

    const authHeader = basicAuthHeader(clientId, clientSecret);
    const digioResult = await fetchDigioStatus(baseUrl, authHeader, lookupId);

    if (!digioResult.ok || !digioResult.parsed) {
      return NextResponse.json(
        {
          success: false,
          message: "Unable to fetch latest Digio agreement status.",
          raw: digioResult.rawText || "",
        },
        { status: digioResult.status || 500 }
      );
    }

    const parsed = digioResult.parsed;

    const signingParties = Array.isArray(parsed?.signing_parties)
      ? parsed.signing_parties
      : Array.isArray(parsed?.signerUrls)
        ? parsed.signerUrls
        : [];

    const signerUrls = signingParties.map((party: any) => ({
      name: party?.name || "",
      reason: party?.reason || "",
      identifier: party?.identifier || "",
      authenticationUrl:
        party?.authentication_url || party?.authenticationUrl || "",
      status: normalizeSignerStatus(party?.status),
    }));

    const anyViewed = signerUrls.some(
      (item: any) => String(item?.status || "").toLowerCase() === "viewed"
    );

    const allSigned =
      signerUrls.length > 0 &&
      signerUrls.every(
        (item: any) => String(item?.status || "").toLowerCase() === "signed"
      );

    const baseAgreementStatus = normalizeAgreementStatus(
      parsed?.agreement_status || parsed?.status
    );

    const computedAgreementStatus = allSigned
      ? "completed"
      : anyViewed
        ? "viewed"
        : baseAgreementStatus;

    const dealerParty =
      signerUrls.find(
        (party: any) =>
          String(party?.reason || "").toLowerCase() === "dealer signer"
      ) || signerUrls[0];

    const signingUrl =
      dealerParty?.authenticationUrl ||
      parsed?.authentication_url ||
      parsed?.signing_url ||
      parsed?.sign_url ||
      parsed?.redirect_url ||
      "";

    return NextResponse.json({
      success: true,
      data: {
        requestId:
          parsed?.id ||
          parsed?.request_id ||
          requestId ||
          providerDocumentId ||
          "",
        providerDocumentId:
          parsed?.document_id ||
          parsed?.documentId ||
          providerDocumentId ||
          requestId ||
          "",
        agreementStatus: computedAgreementStatus,
        providerSigningUrl: signingUrl,
        signerUrls,
        signedAt: allSigned ? new Date().toISOString() : "",
        lastActionTimestamp: new Date().toISOString(),
        completionStatus: allSigned
          ? "Signed"
          : anyViewed
            ? "Viewed / In Progress"
            : "Sent for Signature",
        stampStatus: allSigned ? "Completed" : "Pending",
        rawResponse: JSON.stringify(parsed, null, 2),
      },
    });
  } catch (error) {
    console.error("DIGIO AGREEMENT STATUS ERROR", error);

    return NextResponse.json(
      {
        success: false,
        message: "Unexpected server error while fetching Digio agreement status.",
      },
      { status: 500 }
    );
  }
}