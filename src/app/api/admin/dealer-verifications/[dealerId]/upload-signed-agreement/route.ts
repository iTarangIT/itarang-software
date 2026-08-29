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
import { usesManualAgreement } from "@/lib/dealer/dealer-capabilities";

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
 * Manual agreement upload. Serves two distinct cases:
 *
 * 1. RESCUE (the original purpose) — a finance-enabled NEW-battery dealer whose
 *    Digio signing completed out-of-band (an iTarang signatory's invite link
 *    expired and they signed from the Digio dashboard instead), so the local
 *    agreement_status never flipped to "completed" and approval is hard-blocked.
 *
 * 2. PRIMARY PATH (E-225) — scrap and new+scrap dealers, who have no Digio
 *    agreement at all. They sign on paper and this is the ONLY way their
 *    executed agreement reaches the system.
 *
 * The two differ in what may be demanded of the upload, and the gates below are
 * relaxed for case 2 accordingly: no Digio document has to pre-exist, finance
 * need not be enabled (a scrap dealer normally has it off), and there is no
 * audit trail because nothing machine-generated one. What case 2 adds instead
 * is the paper's own provenance — a reference number and the date signed.
 *
 * Both cases write the same canonical storage paths, so the download routes and
 * ensureDealer*Url() resolve the uploaded copy and Digio is never re-queried.
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

    // E-225 — is this dealer type's agreement signed on paper by design?
    const isManualMode = usesManualAgreement(application.dealer_type);

    // Finance gate applies to e-sign dealers only. For a scrap / new+scrap
    // dealer the agreement is not a FINANCE agreement, and their finance flag
    // is normally off — refusing here would leave them with no way at all to
    // record an executed agreement.
    if (!isManualMode && !application.finance_enabled) {
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
    // For an E-SIGN dealer this upload is a rescue, so we require that an
    // agreement was actually INITIATED — there must be a real Digio document
    // being completed, otherwise "manual completion" is just an unaudited way
    // to fabricate one.
    //
    // For a MANUAL-mode dealer the same check would be unsatisfiable: they
    // never go to Digio (initiate-agreement refuses them), so
    // provider_document_id is null forever and this is the primary path, not a
    // fallback. Either way the write is admin-only and lands a
    // "manual_completion" event for traceability.
    if (!isManualMode && !application.provider_document_id) {
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
    const rawAuditFile = form.get("auditTrail");

    // The audit trail is a Digio artefact — a machine-generated record of who
    // signed from which IP and when. A paper agreement has no such thing, so it
    // is required for e-sign rescues and optional for manual-mode dealers.
    // Demanding one would only teach admins to upload the agreement twice.
    // An empty File is what a browser sends for an untouched file input.
    const auditFile =
      rawAuditFile instanceof File && rawAuditFile.size > 0 ? rawAuditFile : null;
    const hasAuditFile = auditFile !== null;

    if (!(signedFile instanceof File)) {
      return NextResponse.json(
        {
          success: false,
          message: "The signed agreement PDF ('signedAgreement') is required.",
        },
        { status: 400 }
      );
    }
    if (!isManualMode && !hasAuditFile) {
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
    const auditBuffer = auditFile ? await auditFile.arrayBuffer() : null;

    if (!isValidPdfBuffer(signedBuffer)) {
      return NextResponse.json(
        { success: false, message: "Signed agreement file is not a valid PDF." },
        { status: 400 }
      );
    }
    if (auditBuffer && !isValidPdfBuffer(auditBuffer)) {
      return NextResponse.json(
        { success: false, message: "Audit trail file is not a valid PDF." },
        { status: 400 }
      );
    }

    // ─── paper provenance (manual mode) ───────────────────────────────────
    // Kept OUT of provider_document_id — see E-225: "we hold a scan" and "eSign
    // completed" are different assurances and must not share a column.
    const agreementRef = String(form.get("agreementRef") ?? "").trim() || null;
    const rawSignedOn = String(form.get("agreementSignedOn") ?? "").trim();

    // A `date` column, so an ISO yyyy-mm-dd string. Reject anything else rather
    // than letting Postgres coerce a typo into a real-looking date.
    if (rawSignedOn && !/^\d{4}-\d{2}-\d{2}$/.test(rawSignedOn)) {
      return NextResponse.json(
        {
          success: false,
          message: "Signed-on date must be in YYYY-MM-DD format.",
        },
        { status: 400 }
      );
    }
    const agreementSignedOn = rawSignedOn || null;

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
      signedAgreementUrl = filesProxyPath(bucketName, signedPath);
      if (auditBuffer) {
        await putObject(bucketName, auditPath, Buffer.from(auditBuffer), "application/pdf");
        auditTrailUrl = filesProxyPath(bucketName, auditPath);
      }
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
        auditBuffer
          ? supabase.storage.from(bucketName).upload(auditPath, auditBuffer, {
              contentType: "application/pdf",
              upsert: true,
            })
          : Promise.resolve({ error: null } as const),
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
      if (auditBuffer) {
        auditTrailUrl = supabase.storage
          .from(bucketName)
          .getPublicUrl(auditPath).data?.publicUrl;
      }
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
        // Only claim an audit trail when one was actually stored — otherwise a
        // manual-mode row would advertise a path the download route then 404s on.
        ...(auditBuffer ? { audit_trail_storage_path: auditPath } : {}),
        // E-225 — record HOW this was executed, and the paper's own provenance.
        // Written for e-sign rescues too: the completion genuinely was manual,
        // and agreement_mode is the only column that can say so without
        // overloading agreement_status.
        agreement_mode: isManualMode ? "manual" : application.agreement_mode ?? "esign",
        ...(agreementRef ? { agreement_ref: agreementRef } : {}),
        ...(agreementSignedOn ? { agreement_signed_on: agreementSignedOn } : {}),
        agreement_completed_at: application.agreement_completed_at || now,
        // Prefer the date written on the paper over "when an admin got round to
        // uploading it" — signed_at is what the rest of the app displays.
        signed_at:
          application.signed_at ||
          (agreementSignedOn ? new Date(`${agreementSignedOn}T00:00:00Z`) : now),
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
          auditTrailFile: auditFile?.name ?? null,
          // E-225 — distinguishes "this dealer type always signs on paper" from
          // "a Digio e-sign that had to be finished by hand".
          agreementMode: isManualMode ? "manual" : "esign",
          dealerType: application.dealer_type ?? null,
          agreementRef,
          agreementSignedOn,
        },
      });
    } catch (eventErr) {
      console.warn("[UPLOAD SIGNED AGREEMENT] timeline event insert failed (non-blocking):", eventErr);
    }

    return NextResponse.json({
      success: true,
      message: isManualMode
        ? "Signed agreement saved. Agreement marked completed — you can now approve the dealer."
        : "Signed agreement and audit trail saved. Agreement marked completed — you can now approve the dealer.",
      agreementStatus: "completed",
      agreementMode: isManualMode ? "manual" : "esign",
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
