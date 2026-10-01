export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerOnboardingApplications } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import { downloadDigioAuditTrail } from "@/lib/digio";
import { renderDealerAuditTrailPdf as renderAuditTrailPdf } from "@/lib/agreement/render-dealer-audit-trail";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import { isS3Backend, putObject, getObject, filesProxyPath } from "@/lib/storage/s3";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};


function cleanEnv(value?: string) {
  return value?.trim().replace(/^[\"']|[\"']$/g, "");
}

function isValidPdfBuffer(buffer: ArrayBuffer | null | undefined): boolean {
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
        { success: false, message: "Dealer application not found" },
        { status: 404 }
      );
    }

    const documentId = application.provider_document_id || null;

    if (!documentId) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Digio document ID not found. Agreement may not be created yet.",
        },
        { status: 400 }
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
    const filePath =
      application.audit_trail_storage_path ||
      `agreements/${dealerId}/audit-trail.pdf`;

    let fileBuffer: ArrayBuffer | null = null;

    // 1. Try existing stored file first
    if (application.audit_trail_storage_path) {
      if (isS3Backend) {
        const buf = await getObject(bucketName, application.audit_trail_storage_path);
        if (buf) {
          const candidate = buf.buffer.slice(
            buf.byteOffset,
            buf.byteOffset + buf.byteLength
          ) as ArrayBuffer;
          if (isValidPdfBuffer(candidate)) {
            fileBuffer = candidate;
          } else {
            console.warn(
              "[AUDIT TRAIL DOWNLOAD] S3 cache invalid (size=",
              candidate.byteLength,
              "), will re-fetch from Digio"
            );
          }
        }
      }
      // Supabase read (also the fallback when S3 returned nothing)
      if (!fileBuffer) {
        const { data, error } = await supabase.storage
          .from(bucketName)
          .download(application.audit_trail_storage_path);

        if (!error && data) {
          const candidate = await data.arrayBuffer();
          if (isValidPdfBuffer(candidate)) {
            fileBuffer = candidate;
          } else {
            console.warn(
              "[AUDIT TRAIL DOWNLOAD] Supabase cache invalid (size=",
              candidate.byteLength,
              "), will re-fetch from Digio"
            );
          }
        } else {
          console.error(
            "[AUDIT TRAIL DOWNLOAD] Supabase stored file download failed:",
            error?.message
          );
        }
      }
    }

    // 2. If not already stored, generate locally using Digio's audit_log JSON as the
    //    primary path (Digio's /audit_log endpoint returns JSON, not a PDF — we render
    //    the PDF here via Puppeteer). Fall back to the /download_audit_trail PDF variants
    //    only if local rendering fails.
    let effectiveContentType = "application/pdf";

    if (!fileBuffer) {
      // Primary: fetch Digio audit_log JSON + document status, render PDF via Puppeteer.
      try {
        const generatedPdf = await renderAuditTrailPdf(application);
        const candidate = await new Response(generatedPdf as unknown as BodyInit).arrayBuffer();

        if (isValidPdfBuffer(candidate)) {
          fileBuffer = candidate;
          console.log(
            "[AUDIT TRAIL] Generated local audit trail PDF from Digio audit_log JSON, size=",
            fileBuffer.byteLength
          );
        } else {
          console.warn("[AUDIT TRAIL] Local PDF generator returned invalid buffer — falling back to Digio direct-download.");
        }
      } catch (renderErr: any) {
        console.warn(
          "[AUDIT TRAIL] Local PDF generation failed — falling back to Digio direct-download.",
          renderErr?.message
        );
      }

      // Fallback: try Digio's direct-download PDF endpoints (rarely works, but kept for safety).
      if (!fileBuffer) {
        try {
          const { buffer, contentType } = await downloadDigioAuditTrail(documentId, {
            alternateIds: [application.request_id],
          });

          const candidate =
            buffer instanceof ArrayBuffer ? buffer : await new Response(buffer).arrayBuffer();

          if (
            (contentType?.includes("pdf") || contentType?.includes("octet-stream")) &&
            isValidPdfBuffer(candidate)
          ) {
            fileBuffer = candidate;
            effectiveContentType = contentType || "application/pdf";
          }
        } catch (digioErr: any) {
          // entityNotFound means Digio doesn't have the document — surface
          // that to the outer catch so it can return a 404 + auditTrailAvailable:false
          // instead of the generic 500 below. Other errors stay suppressed so
          // we can still fall back to Puppeteer-generated PDF.
          if (digioErr?.entityNotFound) {
            console.warn("[AUDIT TRAIL] Digio direct-download: ENTITY_NOT_FOUND");
            throw digioErr;
          }
          console.warn(
            "[AUDIT TRAIL] Digio direct-download also failed.",
            digioErr?.message
          );
        }
      }

      if (!fileBuffer) {
        return NextResponse.json(
          { success: false, message: "Failed to generate audit trail PDF." },
          { status: 500 }
        );
      }

      // Try to cache in storage for future downloads (non-blocking)
      if (isS3Backend) {
        try {
          await putObject(bucketName, filePath, Buffer.from(fileBuffer), effectiveContentType);
          const auditTrailUrl = filesProxyPath(bucketName, filePath);
          await db
            .update(dealerOnboardingApplications)
            .set({
              audit_trail_url: auditTrailUrl,
              audit_trail_storage_path: filePath,
              updated_at: new Date(),
            })
            .where(eq(dealerOnboardingApplications.id, dealerId));
        } catch (cacheErr) {
          console.warn("[AUDIT TRAIL] S3 caching error (non-blocking):", cacheErr);
        }
      } else {
        try {
          const { error: uploadError } = await supabase.storage
            .from(bucketName)
            .upload(filePath, fileBuffer, {
              contentType: effectiveContentType,
              upsert: true,
            });

          if (!uploadError) {
            const { data: publicUrlData } = supabase.storage
              .from(bucketName)
              .getPublicUrl(filePath);

            const auditTrailUrl = publicUrlData?.publicUrl;

            if (auditTrailUrl) {
              await db
                .update(dealerOnboardingApplications)
                .set({
                  audit_trail_url: auditTrailUrl,
                  audit_trail_storage_path: filePath,
                  updated_at: new Date(),
                })
                .where(eq(dealerOnboardingApplications.id, dealerId));
            }
          } else {
            console.warn("[AUDIT TRAIL] Supabase cache upload failed (non-blocking):", uploadError.message);
          }
        } catch (cacheErr) {
          console.warn("[AUDIT TRAIL] Supabase caching error (non-blocking):", cacheErr);
        }
      }
    }

    if (!fileBuffer) {
      return NextResponse.json(
        {
          success: false,
          message: "Audit trail file could not be prepared",
        },
        { status: 500 }
      );
    }

    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="audit-trail-${dealerId}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error: any) {
    console.error("[DIGIO_AUDIT_TRAIL_DOWNLOAD_ERROR]", error);

    const isEntityNotFound = error?.entityNotFound === true;

    return NextResponse.json(
      {
        success: false,
        auditTrailAvailable: !isEntityNotFound,
        message:
          error instanceof Error
            ? error.message
            : "Failed to download audit trail",
      },
      { status: isEntityNotFound ? 404 : 500 }
    );
  }
}