export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

function cleanEnv(value?: string) {
  return value?.trim().replace(/^[\"']|[\"']$/g, "");
}

function basicAuthHeader(clientId: string, clientSecret: string) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

function isValidPdfBuffer(buffer: ArrayBuffer | null | undefined): buffer is ArrayBuffer {
  if (!buffer || buffer.byteLength < 500) return false;
  const head = new Uint8Array(buffer, 0, 5);
  return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d;
}

export async function GET(_req: NextRequest, context: RouteContext) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;
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

    const supabaseUrl = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL);
    const serviceRoleKey = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);

    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json(
        { success: false, message: "Missing Supabase configuration" },
        { status: 500 }
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const bucketName = "dealer-documents";

    let pdfBuffer: ArrayBuffer | null = null;

    // 1. First try from Supabase storage path
    if (application.signedAgreementStoragePath) {
      console.log(
        "[DOWNLOAD SIGNED AGREEMENT] Trying Supabase path:",
        application.signedAgreementStoragePath
      );

      const { data, error } = await supabase.storage
        .from(bucketName)
        .download(application.signedAgreementStoragePath);

      if (!error && data) {
        const candidate = await data.arrayBuffer();
        if (isValidPdfBuffer(candidate)) {
          pdfBuffer = candidate;
        } else {
          console.warn(
            "[DOWNLOAD SIGNED AGREEMENT] Supabase cache invalid (size=",
            candidate.byteLength,
            "), will re-fetch from Digio"
          );
        }
      } else {
        console.error(
          "[DOWNLOAD SIGNED AGREEMENT] Supabase download error:",
          error?.message
        );
      }
    }

    // 2. Fallback to signedAgreementUrl if present
    if (!pdfBuffer && application.signedAgreementUrl) {
      console.log(
        "[DOWNLOAD SIGNED AGREEMENT] Trying signedAgreementUrl:",
        application.signedAgreementUrl
      );

      const fileRes = await fetch(application.signedAgreementUrl, {
        method: "GET",
        cache: "no-store",
      });

      if (fileRes.ok) {
        const candidate = await fileRes.arrayBuffer();
        if (isValidPdfBuffer(candidate)) {
          pdfBuffer = candidate;
        } else {
          console.warn(
            "[DOWNLOAD SIGNED AGREEMENT] signedAgreementUrl returned invalid PDF (size=",
            candidate.byteLength,
            "), will re-fetch from Digio"
          );
        }
      } else {
        console.error(
          "[DOWNLOAD SIGNED AGREEMENT] signedAgreementUrl fetch failed:",
          fileRes.status,
          fileRes.statusText
        );
      }
    }

    // 3. Final fallback to Digio
    if (!pdfBuffer) {
      if (!application.providerDocumentId) {
        return NextResponse.json(
          { success: false, message: "Signed agreement not available" },
          { status: 400 }
        );
      }

      const clientId = cleanEnv(process.env.DIGIO_CLIENT_ID);
      const clientSecret = cleanEnv(process.env.DIGIO_CLIENT_SECRET);
      const baseUrl =
        cleanEnv(process.env.DIGIO_BASE_URL) || "https://ext.digio.in:444";

      if (!clientId || !clientSecret) {
        return NextResponse.json(
          { success: false, message: "Missing Digio credentials" },
          { status: 500 }
        );
      }

      // Try multiple Digio download endpoints
      const downloadUrls = [
        `${baseUrl}/v2/client/document/download?document_id=${application.providerDocumentId}`,
        `${baseUrl}/v2/client/document/${application.providerDocumentId}/download`,
      ];

      let digioResponse: Response | null = null;

      for (const downloadUrl of downloadUrls) {
        console.log("[DOWNLOAD SIGNED AGREEMENT] Trying Digio URL:", downloadUrl);

        const res = await fetch(downloadUrl, {
          method: "GET",
          headers: {
            Authorization: basicAuthHeader(clientId, clientSecret),
            Accept: "application/pdf, application/octet-stream, */*",
          },
          cache: "no-store",
        });

        const ct = res.headers.get("content-type") || "";

        if (res.ok && (ct.includes("pdf") || ct.includes("octet-stream"))) {
          digioResponse = res;
          break;
        }

        const errText = await res.text();
        console.warn("[DOWNLOAD SIGNED AGREEMENT] Digio URL failed:", downloadUrl, res.status, errText.slice(0, 300));
      }

      // If both endpoints failed, check agreement status first
      if (!digioResponse) {
        // Query Digio for the document status to get the signed URL directly
        const statusUrl = `${baseUrl}/v2/client/document/${application.providerDocumentId}`;
        console.log("[DOWNLOAD SIGNED AGREEMENT] Checking Digio document status:", statusUrl);

        const statusRes = await fetch(statusUrl, {
          method: "GET",
          headers: {
            Authorization: basicAuthHeader(clientId, clientSecret),
            Accept: "application/json",
          },
          cache: "no-store",
        });

        if (statusRes.ok) {
          const statusData = await statusRes.json();
          const agreementStatus = String(statusData?.agreement_status || statusData?.status || "").toLowerCase();

          // Check if a signed file URL is available in the status response
          const signedFileUrl =
            statusData?.signed_file_url ||
            statusData?.signed_agreement_url ||
            statusData?.executed_file_url ||
            statusData?.file_url ||
            statusData?.download_url ||
            null;

          if (signedFileUrl) {
            console.log("[DOWNLOAD SIGNED AGREEMENT] Found signed URL from status:", signedFileUrl);
            const signedRes = await fetch(signedFileUrl, {
              method: "GET",
              headers: {
                Authorization: basicAuthHeader(clientId, clientSecret),
                Accept: "application/pdf, application/octet-stream, */*",
              },
              cache: "no-store",
            });

            if (signedRes.ok) {
              digioResponse = signedRes;
            }
          }

          if (!digioResponse) {
            const notCompleted = !["completed", "signed"].includes(agreementStatus);
            return NextResponse.json(
              {
                success: false,
                message: notCompleted
                  ? `Agreement is not fully signed yet. Current status: "${agreementStatus}". Please wait for all signers to complete.`
                  : "Digio system error — the signed document may not be ready yet. Please try again in a few minutes.",
                agreementStatus,
              },
              { status: notCompleted ? 400 : 502 }
            );
          }
        } else {
          return NextResponse.json(
            {
              success: false,
              message: "Failed to download signed agreement from Digio. The document may not be ready yet. Please try again in a few minutes.",
            },
            { status: 502 }
          );
        }
      }

      pdfBuffer = await digioResponse!.arrayBuffer();

      // Validate the PDF has actual content and starts with %PDF- magic bytes
      if (!isValidPdfBuffer(pdfBuffer)) {
        console.error(
          "[DOWNLOAD SIGNED AGREEMENT] Digio returned invalid PDF (size=",
          pdfBuffer.byteLength,
          ")"
        );
        return NextResponse.json(
          {
            success: false,
            message: "Digio returned an empty or corrupt document. Please try again later.",
          },
          { status: 502 }
        );
      }

      // Save to Supabase for future downloads
      const filePath =
        application.signedAgreementStoragePath ||
        `agreements/${dealerId}/signed-agreement.pdf`;

      const { error: uploadError } = await supabase.storage
        .from(bucketName)
        .upload(filePath, pdfBuffer, {
          contentType: "application/pdf",
          upsert: true,
        });

      if (!uploadError) {
        const { data: publicUrlData } = supabase.storage
          .from(bucketName)
          .getPublicUrl(filePath);

        const signedAgreementUrl = publicUrlData?.publicUrl;

        await db
          .update(dealerOnboardingApplications)
          .set({
            signedAgreementStoragePath: filePath,
            signedAgreementUrl: signedAgreementUrl || application.signedAgreementUrl,
            updatedAt: new Date(),
          })
          .where(eq(dealerOnboardingApplications.id, dealerId));
      } else {
        console.error(
          "[DOWNLOAD SIGNED AGREEMENT] Supabase upload failed:",
          uploadError.message
        );
      }
    }

    if (!pdfBuffer) {
      return NextResponse.json(
        { success: false, message: "Signed agreement PDF could not be prepared" },
        { status: 500 }
      );
    }

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
      {
        success: false,
        message: error?.message || "Download failed",
      },
      { status: 500 }
    );
  }
}