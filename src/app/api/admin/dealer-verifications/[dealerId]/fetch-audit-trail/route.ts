import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { insertAgreementEvent } from "@/lib/agreement/tracking";

type Context = {
  params: Promise<{ dealerId: string }>;
};

function cleanEnv(value?: string) {
  return value?.trim().replace(/^[\"']|[\"']$/g, "");
}

function basicAuthHeader(clientId: string, clientSecret: string) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

/**
 * Keep this configurable because Digio account/docs can vary.
 * If needed, set:
 * DIGIO_AUDIT_TRAIL_PATH_TEMPLATE=/v2/client/document/{documentId}/audit-trail/download
 */
function buildAuditTrailEndpoint(baseUrl: string, documentId: string) {
  const template =
    cleanEnv(process.env.DIGIO_AUDIT_TRAIL_PATH_TEMPLATE) ||
    "/v2/client/document/{documentId}/audit-trail/download";

  const safeBase = baseUrl.replace(/\/+$/, "");
  const safePath = template.replace("{documentId}", encodeURIComponent(documentId));

  return `${safeBase}${safePath.startsWith("/") ? "" : "/"}${safePath}`;
}

async function getApplicationOr404(dealerId: string) {
  const rows = await db
    .select()
    .from(dealerOnboardingApplications)
    .where(eq(dealerOnboardingApplications.id, dealerId))
    .limit(1);

  return rows[0] || null;
}

async function fetchDigioAuditTrail(documentId: string) {
  const clientId = cleanEnv(process.env.DIGIO_CLIENT_ID);
  const clientSecret = cleanEnv(process.env.DIGIO_CLIENT_SECRET);
  const baseUrl =
    cleanEnv(process.env.DIGIO_BASE_URL) || "https://ext.digio.in:444";

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing Digio configuration. Set DIGIO_CLIENT_ID and DIGIO_CLIENT_SECRET."
    );
  }

  const endpoint = buildAuditTrailEndpoint(baseUrl, documentId);

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: basicAuthHeader(clientId, clientSecret),
      Accept: "application/pdf, application/json, */*",
    },
    cache: "no-store",
  });

  return response;
}

/**
 * POST:
 * 1. verifies Digio audit trail is fetchable
 * 2. stores an INTERNAL proxy URL into auditTrailUrl
 * 3. inserts agreement event
 *
 * This avoids needing storage right now.
 */
export async function POST(_req: NextRequest, context: Context) {
  try {
    const { dealerId } = await context.params;

    const application = await getApplicationOr404(dealerId);

    if (!application) {
      return NextResponse.json(
        { success: false, message: "Application not found" },
        { status: 404 }
      );
    }

    if (!application.providerDocumentId) {
      return NextResponse.json(
        {
          success: false,
          message: "providerDocumentId is missing. Agreement was not initiated properly.",
        },
        { status: 400 }
      );
    }

    const digioResponse = await fetchDigioAuditTrail(application.providerDocumentId);

    const contentType = digioResponse.headers.get("content-type") || "";

    if (!digioResponse.ok) {
      let raw: any = null;

      try {
        raw = contentType.includes("application/json")
          ? await digioResponse.json()
          : await digioResponse.text();
      } catch {
        raw = null;
      }

      return NextResponse.json(
        {
          success: false,
          message:
            (typeof raw === "object" && raw?.message) ||
            (typeof raw === "object" && raw?.error) ||
            "Failed to fetch audit trail from Digio",
          raw,
        },
        { status: digioResponse.status }
      );
    }

    const appBaseUrl =
      cleanEnv(process.env.APP_URL) ||
      cleanEnv(process.env.NEXT_PUBLIC_APP_URL) ||
      "http://localhost:3000";

    const internalAuditTrailUrl = `${appBaseUrl}/api/admin/dealer-verifications/${dealerId}/fetch-audit-trail?download=1`;

    await db
      .update(dealerOnboardingApplications)
      .set({
        auditTrailUrl: internalAuditTrailUrl,
        lastActionTimestamp: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(dealerOnboardingApplications.id, dealerId));

    await insertAgreementEvent({
      applicationId: application.id,
      providerDocumentId: application.providerDocumentId,
      requestId: application.requestId || null,
      eventType: "audit_trail_fetched",
      eventStatus: "available",
      eventPayload: {
        storedAs: "internal_proxy_url",
        auditTrailUrl: internalAuditTrailUrl,
      },
    });

    return NextResponse.json({
      success: true,
      message: "Audit trail fetched successfully",
      data: {
        auditTrailUrl: internalAuditTrailUrl,
      },
    });
  } catch (error: any) {
    console.error("FETCH AUDIT TRAIL ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Failed to fetch audit trail",
      },
      { status: 500 }
    );
  }
}

/**
 * GET:
 * Proxies the actual Digio audit trail file to the browser.
 * This is what your UI can open when user clicks View / Download.
 */
export async function GET(req: NextRequest, context: Context) {
  try {
    const { dealerId } = await context.params;
    const download = req.nextUrl.searchParams.get("download");

    const application = await getApplicationOr404(dealerId);

    if (!application) {
      return NextResponse.json(
        { success: false, message: "Application not found" },
        { status: 404 }
      );
    }

    if (!application.providerDocumentId) {
      return NextResponse.json(
        {
          success: false,
          message: "providerDocumentId is missing. Cannot fetch audit trail.",
        },
        { status: 400 }
      );
    }

    /**
     * If someone opens the route without ?download=1,
     * return the saved metadata instead of file bytes.
     */
    if (download !== "1") {
      return NextResponse.json({
        success: true,
        data: {
          applicationId: application.id,
          providerDocumentId: application.providerDocumentId,
          auditTrailUrl: application.auditTrailUrl || null,
        },
      });
    }

    const digioResponse = await fetchDigioAuditTrail(application.providerDocumentId);
    const contentType = digioResponse.headers.get("content-type") || "application/pdf";

    if (!digioResponse.ok) {
      let raw: any = null;

      try {
        raw = contentType.includes("application/json")
          ? await digioResponse.json()
          : await digioResponse.text();
      } catch {
        raw = null;
      }

      return NextResponse.json(
        {
          success: false,
          message:
            (typeof raw === "object" && raw?.message) ||
            (typeof raw === "object" && raw?.error) ||
            "Failed to download audit trail from Digio",
          raw,
        },
        { status: digioResponse.status }
      );
    }

    const arrayBuffer = await digioResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const filename = `audit-trail-${application.providerDocumentId}.pdf`;

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": contentType.includes("pdf")
          ? "application/pdf"
          : contentType,
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error: any) {
    console.error("DOWNLOAD AUDIT TRAIL ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Failed to download audit trail",
      },
      { status: 500 }
    );
  }
}