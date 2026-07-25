export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  dealerAgreementEvents,
  dealerOnboardingApplications,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import { normalizeAgreementStatus } from "@/lib/agreement/status";
import { isS3Backend, putObject, filesProxyPath } from "@/lib/storage/s3";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

function cleanEnv(value?: string) {
  return value?.trim().replace(/^["']|["']$/g, "");
}

function isValidPdfBuffer(buffer: ArrayBuffer | null | undefined): boolean {
  if (!buffer || buffer.byteLength < 500) return false;
  const head = new Uint8Array(buffer, 0, 5);
  // %PDF-
  return (
    head[0] === 0x25 &&
    head[1] === 0x50 &&
    head[2] === 0x44 &&
    head[3] === 0x46 &&
    head[4] === 0x2d
  );
}

/**
 * Manual agreement completion.
 *
 * For finance-enabled dealers whose Digio signing was completed out-of-band
 * (e.g. an iTarang signatory's invite link expired and they signed from the
 * Digio dashboard instead), the local agreement_status never flips to
 * "completed", which hard-blocks approval. This endpoint lets an admin upload
 * the final signed-agreement PDF and audit-trail PDF by hand, caches both in
 * Supabase at the canonical paths the rest of the app reads from, and marks the
 * agreement completed — unblocking the Approve & Activate flow.
 *
 * The download routes (download-signed-agreement, audit-trail) prefer the
 * stored storage_path/url, and ensureDealer*Url() short-circuit on the url
 * columns, so the uploaded files flow straight through to the download buttons
 * and the welcome-email attachments — Digio is never re-queried.
 */
export async function POST(req: NextRequest, context: RouteContext) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;
  try {
    const { dealerId } = await context.params;

    const [application] = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, dealerId))
      .limit(1);

    if (!application) {
      return NextResponse.json(
        { success: false, message: "Dealer application not found" },
        { status: 404 }
      );
    }

    if (application.onboarding_status === "rejected") {
      return NextResponse.json(
        { success: false, message: "This application is rejected and locked." },
        { status: 400 }
      );
    }

    if (!application.finance_enabled) {
      return NextResponse.json(
        {
          success: false,
          message:
            "This dealer is not finance-enabled — no agreement to complete.",
        },
        { status: 400 }
      );
    }

    // ─── initiated-but-not-completed gate ─────────────────────────────────
    // Manual upload bypasses the Digio "completed" gate. It's the fallback for
    // agreements whose completion can't be synced from Digio — an expired signer
    // link, signing finished out-of-band on the Digio dashboard, or a document
    // created in a different Digio environment that 404s here. We require only
    // that an agreement was actually INITIATED (so there's a real document to
    // complete) and isn't already completed. (finance_enabled + not-rejected are
    // checked above.) The upload is admin-only and recorded as a
    // "manual_completion" event for traceability.
    if (!application.provider_document_id) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Agreement has not been initiated yet — there is nothing to complete manually.",
        },
        { status: 400 }
      );
    }
    if (normalizeAgreementStatus(application.agreement_status) === "completed") {
      return NextResponse.json(
        {
          success: false,
          message: "Agreement is already completed.",
        },
        { status: 400 }
      );
    }

    // ─── read uploaded files ──────────────────────────────────────────────
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json(
        { success: false, message: "Expected multipart/form-data with file uploads." },
        { status: 400 }
      );
    }

    const signedFile = form.get("signedAgreement");
    const auditFile = form.get("auditTrail");

    if (!(signedFile instanceof File) || !(auditFile instanceof File)) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Both files are required: 'signedAgreement' (the signed agreement PDF) and 'auditTrail' (the audit trail PDF).",
        },
        { status: 400 }
      );
    }

    const signedBuffer = await signedFile.arrayBuffer();
    const auditBuffer = await auditFile.arrayBuffer();

    if (!isValidPdfBuffer(signedBuffer)) {
      return NextResponse.json(
        { success: false, message: "Signed agreement file is not a valid PDF." },
        { status: 400 }
      );
    }
    if (!isValidPdfBuffer(auditBuffer)) {
      return NextResponse.json(
        { success: false, message: "Audit trail file is not a valid PDF." },
        { status: 400 }
      );
    }

    // ─── upload to storage ────────────────────────────────────────────────
    const bucketName = "dealer-documents";

    // Canonical paths — identical to ensureDealer*Url() and the download routes
    // so everything downstream resolves the manually-uploaded copy.
    const signedPath = `agreements/${dealerId}/signed-agreement.pdf`;
    const auditPath = `agreements/${dealerId}/audit-trail.pdf`;

    let signedAgreementUrl: string | undefined;
    let auditTrailUrl: string | undefined;

    if (isS3Backend) {
      await putObject(bucketName, signedPath, Buffer.from(signedBuffer), "application/pdf");
      await putObject(bucketName, auditPath, Buffer.from(auditBuffer), "application/pdf");
      signedAgreementUrl = filesProxyPath(bucketName, signedPath);
      auditTrailUrl = filesProxyPath(bucketName, auditPath);
    } else {
      const supabaseUrl = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL);
      const serviceRoleKey = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
      if (!supabaseUrl || !serviceRoleKey) {
        return NextResponse.json(
          { success: false, message: "Missing Supabase configuration" },
          { status: 500 }
        );
      }

      const supabase = createClient(supabaseUrl, serviceRoleKey);

      const [signedUpload, auditUpload] = await Promise.all([
        supabase.storage.from(bucketName).upload(signedPath, signedBuffer, {
          contentType: "application/pdf",
          upsert: true,
        }),
        supabase.storage.from(bucketName).upload(auditPath, auditBuffer, {
          contentType: "application/pdf",
          upsert: true,
        }),
      ]);

      if (signedUpload.error || auditUpload.error) {
        console.error("[UPLOAD SIGNED AGREEMENT] supabase upload failed", {
          signed: signedUpload.error?.message,
          audit: auditUpload.error?.message,
        });
        return NextResponse.json(
          { success: false, message: "Failed to store the uploaded documents." },
          { status: 500 }
        );
      }

      signedAgreementUrl = supabase.storage
        .from(bucketName)
        .getPublicUrl(signedPath).data?.publicUrl;
      auditTrailUrl = supabase.storage
        .from(bucketName)
        .getPublicUrl(auditPath).data?.publicUrl;
    }

    // ─── flip agreement to completed (mirrors refresh-agreement) ──────────
    const now = new Date();
    await db
      .update(dealerOnboardingApplications)
      .set({
        agreement_status: "completed",
        // An already-approved dealer completing their agreement via the
        // post-approval finance-enablement flow stays "approved" — rewinding
        // review_status would put a live dealer back in the pending queue.
        ...(application.onboarding_status === "approved"
          ? {}
          : {
              review_status: "agreement_completed",
              completion_status: "completed",
            }),
        signed_agreement_url: signedAgreementUrl || application.signed_agreement_url,
        signed_agreement_storage_path: signedPath,
        audit_trail_url: auditTrailUrl || application.audit_trail_url,
        audit_trail_storage_path: auditPath,
        agreement_completed_at: application.agreement_completed_at || now,
        signed_at: application.signed_at || now,
        agreement_failure_reason: null,
        last_action_timestamp: now,
        updated_at: now,
      })
      .where(eq(dealerOnboardingApplications.id, dealerId));

    // Audit breadcrumb in the agreement timeline so it's visible that the
    // completion was a manual upload, not a Digio-synced event.
    try {
      const actorEmail = auth.user.email ?? null;
      await db.insert(dealerAgreementEvents).values({
        application_id: application.id,
        provider_document_id: application.provider_document_id,
        request_id: application.request_id,
        event_type: "manual_completion",
        event_status: "completed",
        event_payload: {
          source: "admin_manual_upload",
          actorEmail,
          signedAgreementFile: signedFile.name,
          auditTrailFile: auditFile.name,
        },
      });
    } catch (eventErr) {
      console.warn("[UPLOAD SIGNED AGREEMENT] timeline event insert failed (non-blocking):", eventErr);
    }

    return NextResponse.json({
      success: true,
      message:
        "Signed agreement and audit trail saved. Agreement marked completed — you can now approve the dealer.",
      agreementStatus: "completed",
      signedAgreementUrl,
      auditTrailUrl,
    });
  } catch (error: any) {
    console.error("UPLOAD SIGNED AGREEMENT ERROR:", error);
    return NextResponse.json(
      { success: false, message: error?.message || "Failed to save documents" },
      { status: 500 }
    );
  }
}
