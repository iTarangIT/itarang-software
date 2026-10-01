export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  dealerAgreementEvents,
  dealerOnboardingApplications,
} from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import { normalizeAgreementStatus } from "@/lib/agreement/status";
import { isS3Backend, putObject, filesProxyPath } from "@/lib/storage/s3";
import { usesManualAgreement } from "@/lib/dealer/dealer-capabilities";
import { checkUploadedAgreement } from "@/lib/agreement/readExecutedAgreement";

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
 * ensureDealer*Url() resolve the uploaded copy and Digio is never re-queried. *
 * ID 55 (29 Sep 2026): the system READS the files — signers, signing dates,
 * Digio document ID, dealer name / GSTIN — checks them against the application
 * and Digio (checkUploadedAgreement), and writes the signed date and reference
 * from them. A mismatch needs the admin's confirmation with a reason. Several
 * audit trails can be uploaded, and more added after completion.
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
    // ID 55: once complete, the upload ADDS files (a second audit trail, a
    // clearer scan) and never changes the status or dates again.
    const alreadyCompleted =
      normalizeAgreementStatus(application.agreement_status) === "completed";

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

    // More than one of each is allowed (ID 55: "more than one trail"). An
    // empty File is what a browser sends for an untouched file input.
    const filesOf = (field: string) =>
      form.getAll(field).filter((f): f is File => f instanceof File && f.size > 0);
    const signedFiles = filesOf("signedAgreement");
    const auditFiles = filesOf("auditTrail");

    // The audit trail is a Digio artefact — a machine-generated record of who
    // signed from which IP and when. A paper agreement has no such thing, so it
    // is required for e-sign rescues and optional for manual-mode dealers.
    if (alreadyCompleted) {
      if (signedFiles.length + auditFiles.length === 0) {
        return NextResponse.json(
          { success: false, message: "Choose at least one file to add." },
          { status: 400 }
        );
      }
    } else {
      if (signedFiles.length === 0) {
        return NextResponse.json(
          { success: false, message: "The signed agreement PDF ('signedAgreement') is required." },
          { status: 400 }
        );
      }
      if (!isManualMode && auditFiles.length === 0) {
        return NextResponse.json(
          {
            success: false,
            message:
              "Both are required: the signed agreement PDF ('signedAgreement') and at least one audit trail PDF ('auditTrail').",
          },
          { status: 400 }
        );
      }
    }

    const uploads: Array<{ kind: "signed_agreement" | "audit_trail"; file: File; buffer: Buffer }> = [];
    for (const [kind, list] of [
      ["signed_agreement", signedFiles],
      ["audit_trail", auditFiles],
    ] as const) {
      for (const file of list) {
        const ab = await file.arrayBuffer();
        if (!isValidPdfBuffer(ab)) {
          return NextResponse.json(
            { success: false, message: `"${file.name}" is not a valid PDF.` },
            { status: 400 }
          );
        }
        uploads.push({ kind, file, buffer: Buffer.from(ab) });
      }
    }

    // ─── paper provenance (manual mode) ───────────────────────────────────
    // Kept OUT of provider_document_id — see E-225: "we hold a scan" and "eSign
    // completed" are different assurances and must not share a column.
    const typedRef = String(form.get("agreementRef") ?? "").trim() || null;
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
    const typedSignedOn = rawSignedOn || null;

    // ─── read and check the documents (ID 55) ─────────────────────────────
    // The system reads every file (signers, dates, document ID, dealer name /
    // GSTIN) and checks them against this application and Digio. A mismatch is
    // not saved unless the admin confirms it with a reason — the page resends
    // the same files with confirmMismatch=true.
    const { result: check, docs: extracted } = await checkUploadedAgreement({
      application,
      manualMode: isManualMode,
      files: uploads.map((u) => ({ kind: u.kind, buffer: u.buffer })),
    });
    const confirmMismatch = String(form.get("confirmMismatch") ?? "") === "true";
    const mismatchReason = String(form.get("mismatchReason") ?? "").trim();
    if (check.verdict !== "verified" && !(confirmMismatch && mismatchReason.length >= 5)) {
      return NextResponse.json(
        {
          success: false,
          needsConfirmation: true,
          message:
            check.verdict === "unreadable"
              ? "The system could not read the uploaded files. Check them, or confirm with a reason to save anyway."
              : "The uploaded documents do not match this dealer. Check them, or confirm with a reason to save anyway.",
          verdict: check.verdict,
          reasons: check.reasons,
          read: {
            signedOn: check.signedOn,
            documentId: check.documentId,
            referenceNumber: check.referenceNumber,
            signers: check.signers,
          },
        },
        { status: 422 }
      );
    }

    // ─── upload to storage ────────────────────────────────────────────────
    const bucketName = "dealer-documents";

    // Canonical paths — identical to ensureDealer*Url() and the download routes
    // so everything downstream resolves the manually-uploaded copy. They hold
    // the FIRST signed agreement / audit trail; every file also gets its own
    // key so a second trail never overwrites the first.
    const signedPath = `agreements/${dealerId}/signed-agreement.pdf`;
    const auditPath = `agreements/${dealerId}/audit-trail.pdf`;

    let supabase: ReturnType<typeof createClient> | null = null;
    if (!isS3Backend) {
      const supabaseUrl = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL);
      const serviceRoleKey = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
      if (!supabaseUrl || !serviceRoleKey) {
        return NextResponse.json(
          { success: false, message: "Missing Supabase configuration" },
          { status: 500 }
        );
      }
      supabase = createClient(supabaseUrl, serviceRoleKey);
    }
    const store = async (path: string, buffer: Buffer): Promise<string | undefined> => {
      if (isS3Backend) {
        await putObject(bucketName, path, buffer, "application/pdf");
        return filesProxyPath(bucketName, path);
      }
      const { error } = await supabase!.storage
        .from(bucketName)
        .upload(path, buffer, { contentType: "application/pdf", upsert: true });
      if (error) throw new Error(`Failed to store ${path}: ${error.message}`);
      return supabase!.storage.from(bucketName).getPublicUrl(path).data?.publicUrl;
    };

    const stamp = Date.now();
    const stored: Array<{ kind: string; file: File; path: string; url: string | undefined; index: number }> = [];
    for (const [i, u] of uploads.entries()) {
      const path = `agreements/${dealerId}/files/${stamp}-${i + 1}-${u.kind}.pdf`;
      stored.push({ kind: u.kind, file: u.file, path, url: await store(path, u.buffer), index: i });
    }

    const firstSigned = uploads.find((u) => u.kind === "signed_agreement");
    const firstAudit = uploads.find((u) => u.kind === "audit_trail");
    let signedAgreementUrl: string | undefined;
    let auditTrailUrl: string | undefined;
    // Canonical copies: always on first completion; afterwards only to fill a
    // gap (a paper dealer adding their first trail), never to overwrite.
    if (firstSigned && !alreadyCompleted) {
      signedAgreementUrl = await store(signedPath, firstSigned.buffer);
    }
    const fillAudit = !!firstAudit && (!alreadyCompleted || !application.audit_trail_storage_path);
    if (fillAudit && firstAudit) {
      auditTrailUrl = await store(auditPath, firstAudit.buffer);
    }

    const now = new Date();
    // Dates and reference from the documents; what the admin typed wins.
    const signedOn = typedSignedOn ?? check.signedOn;
    const agreementRef = typedRef ?? check.referenceNumber;

    if (!alreadyCompleted) {
      // ─── flip agreement to completed (mirrors refresh-agreement) ────────
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
          ...(fillAudit ? { audit_trail_storage_path: auditPath } : {}),
          // E-225 — record HOW this was executed, and the paper's own provenance.
          agreement_mode: isManualMode ? "manual" : application.agreement_mode ?? "esign",
          ...(agreementRef ? { agreement_ref: agreementRef } : {}),
          ...(signedOn ? { agreement_signed_on: signedOn } : {}),
          agreement_completed_at: application.agreement_completed_at || now,
          // The day the documents show the last party signed, over "when an
          // admin got round to uploading it" — signed_at is what the rest of
          // the app displays.
          signed_at:
            application.signed_at ||
            (signedOn ? new Date(`${signedOn}T00:00:00+05:30`) : now),
          agreement_failure_reason: null,
          last_action_timestamp: now,
          updated_at: now,
        })
        .where(eq(dealerOnboardingApplications.id, dealerId));
    } else if (fillAudit) {
      await db
        .update(dealerOnboardingApplications)
        .set({
          audit_trail_url: auditTrailUrl || application.audit_trail_url,
          audit_trail_storage_path: auditPath,
          updated_at: now,
        })
        .where(eq(dealerOnboardingApplications.id, dealerId));
    }

    // ─── per-file record (E-313) — fail-tolerant ──────────────────────────
    const confirmedBy = check.verdict !== "verified" ? auth.user.id : null;
    for (const f of stored) {
      try {
        await db.execute(sql`
          INSERT INTO dealer_agreement_documents
            (application_id, kind, file_name, byte_size, storage_bucket, storage_path, file_url,
             extracted, verdict, reasons, mismatch_confirmed_by, mismatch_reason, uploaded_by)
          VALUES (${dealerId}, ${f.kind}, ${f.file.name}, ${f.file.size}, ${bucketName}, ${f.path},
                  ${f.url ?? null}, ${JSON.stringify(extracted[f.index] ?? {})}::jsonb, ${check.verdict},
                  ${JSON.stringify(check.reasons)}::jsonb, ${confirmedBy},
                  ${confirmedBy ? mismatchReason : null}, ${auth.user.id})
        `);
      } catch (docErr) {
        console.warn("[UPLOAD SIGNED AGREEMENT] document row insert failed (E-313 applied?):", docErr);
      }
    }

    // Audit breadcrumb in the agreement timeline so it's visible that the
    // completion was a manual upload, not a Digio-synced event.
    try {
      const actorEmail = auth.user.email ?? null;
      await db.insert(dealerAgreementEvents).values({
        application_id: application.id,
        provider_document_id: application.provider_document_id,
        request_id: application.request_id,
        event_type: alreadyCompleted ? "manual_documents_added" : "manual_completion",
        event_status: "completed",
        event_payload: {
          source: "admin_manual_upload",
          actorEmail,
          signedAgreementFiles: signedFiles.map((f) => f.name),
          auditTrailFiles: auditFiles.map((f) => f.name),
          // E-225 — distinguishes "this dealer type always signs on paper" from
          // "a Digio e-sign that had to be finished by hand".
          agreementMode: isManualMode ? "manual" : "esign",
          dealerType: application.dealer_type ?? null,
          agreementRef,
          agreementSignedOn: signedOn,
          // ID 55 — what the system read and whether it matched.
          verification: {
            verdict: check.verdict,
            reasons: check.reasons,
            documentId: check.documentId,
            signers: check.signers,
            mismatchConfirmedBy: confirmedBy,
            mismatchReason: confirmedBy ? mismatchReason : null,
          },
        },
      });
    } catch (eventErr) {
      console.warn("[UPLOAD SIGNED AGREEMENT] timeline event insert failed (non-blocking):", eventErr);
    }

    return NextResponse.json({
      success: true,
      message: alreadyCompleted
        ? `${uploads.length} document(s) added to the agreement.`
        : check.verdict === "verified"
          ? `Documents read and matched${signedOn ? ` — signed on ${signedOn}` : ""}. Agreement marked completed — you can now approve the dealer.`
          : "Documents saved with your confirmation. Agreement marked completed — you can now approve the dealer.",
      agreementStatus: "completed",
      agreementMode: isManualMode ? "manual" : "esign",
      verification: { verdict: check.verdict, reasons: check.reasons, signedOn, documentId: check.documentId },
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
