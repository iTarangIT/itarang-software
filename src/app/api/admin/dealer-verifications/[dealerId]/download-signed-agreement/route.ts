import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

function cleanEnv(value?: string) {
  return value?.trim().replace(/^[\"']|[\"']$/g, "");
}

function basicAuthHeader(clientId: string, clientSecret: string) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const { dealerId } = await context.params;

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

    if (!application.providerDocumentId) {
      return NextResponse.json(
        { success: false, message: "Agreement not available" },
        { status: 400 }
      );
    }

    const clientId = cleanEnv(process.env.DIGIO_CLIENT_ID);
    const clientSecret = cleanEnv(process.env.DIGIO_CLIENT_SECRET);
    const baseUrl =
      cleanEnv(process.env.DIGIO_BASE_URL) || "https://ext.digio.in:444";

    if (!clientId || !clientSecret) {
      return NextResponse.json(
        {
          success: false,
          message: "Missing Digio credentials",
        },
        { status: 500 }
      );
    }

    const downloadUrl = `${baseUrl}/v2/client/document/download?document_id=${application.providerDocumentId}`;

    const digioResponse = await fetch(downloadUrl, {
      method: "GET",
      headers: {
        Authorization: basicAuthHeader(clientId, clientSecret),
      },
      cache: "no-store",
    });

    if (!digioResponse.ok) {
      const errorText = await digioResponse.text();
      return NextResponse.json(
        {
          success: false,
          message: "Failed to download signed agreement from Digio",
          raw: errorText,
        },
        { status: digioResponse.status }
      );
    }

    const pdfBuffer = await digioResponse.arrayBuffer();

    return new NextResponse(pdfBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="signed-agreement-${dealerId}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error: any) {
    console.error("DOWNLOAD SIGNED AGREEMENT ERROR:", error);

    return NextResponse.json(
      { success: false, message: error?.message || "Download failed" },
      { status: 500 }
    );
  }
}