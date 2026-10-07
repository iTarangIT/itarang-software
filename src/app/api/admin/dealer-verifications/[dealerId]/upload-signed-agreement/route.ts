export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  dealerAgreementDocuments,
  dealerAgreementEvents,
  dealerAgreementOverrideRequests,
  dealerOnboardingApplications,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import { normalizeAgreementStatus } from "@/lib/agreement/status";
import { usesManualAgreement } from "@/lib/dealer/dealer-capabilities";
import { checkUploadedAgreement } from "@/lib/agreement/readExecutedAgreement";
import {
  AGREEMENT_BUCKET,
  MIGRATION_MISSING_MESSAGE,
  OVERRIDE_REASON_MIN,
  agreementCompletionValues,
  auditTrailPath,
  isMissingSchemaError,
  signedAgreementPath,
  storeAgreementPdf,
} from "@/lib/agreement/executedAgreementStore";
import { notifyAgreementApprovalRequested } from "@/lib/notifications/events";
import { markAgreementOutcome } from "@/lib/onboarding/leadMilestones";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

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
 *
 * ID 55 (29 Sep 2026; tightened 01 Oct after the 30 Sep review): the system
 * READS every file — signers, signing dates, Digio document ID, dealer name /
 * GSTIN — and checks each against the application, Digio and what the admin
 * typed (checkUploadedAgreement).
 *
 *   verified   the agreement is completed here, with the signed date and
 *              reference written FROM THE DOCUMENTS.
 *   otherwise  the uploader cannot complete it. They may ask for a second
 *              approval with a reason: the files are stored, the status does
 *              not move, and someone else decides
 *              (agreement-override/[requestId], E-318).
 *
 * Status, per-file records and the timeline event commit in ONE transaction —
 * there is no completed agreement without its record.
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
    // fallback.
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
    // Every file is read and has to stand on its own; the typed date and
    // reference are checked against what was read rather than replacing it.
    const { result: check, docs: extracted } = await checkUploadedAgreement({
      application,
      manualMode: isManualMode,
      files: uploads.map((u) => ({ kind: u.kind, buffer: u.buffer, fileName: u.file.name })),
      typed: { signedOn: typedSignedOn, referenceNumber: typedRef },
    });
    const read = {
      signedOn: check.signedOn,
      documentId: check.documentId,
      referenceNumber: check.referenceNumber,
      signers: check.signers,
    };

    // `confirmMismatch` is the pre-E-318 name of the same request.
    const requestApproval =
      String(form.get("requestApproval") ?? form.get("confirmMismatch") ?? "") === "true";
    const requestReason = String(form.get("mismatchReason") ?? "").trim();

    if (check.verdict !== "verified" && !(requestApproval && requestReason.length >= OVERRIDE_REASON_MIN)) {
      return NextResponse.json(
        {
          success: false,
          needsConfirmation: true,
          needsApproval: true,
          reasonMinLength: OVERRIDE_REASON_MIN,
          message:
            check.verdict === "unreadable"
              ? "The system could not read the uploaded files. Check them, or send them for a second approval with a reason."
              : "The uploaded documents could not be verified for this dealer. Check them, or send them for a second approval with a reason.",
          verdict: check.verdict,
          reasons: check.reasons,
          read,
        },
        { status: 422 }
      );
    }

    // ─── upload to storage ────────────────────────────────────────────────
    // Every file gets a key of its own, so a second trail never overwrites the
    // first. The canonical keys are written only for a verified upload — a
    // file still waiting for approval must not be what the download routes and
    // the welcome email serve.
    const stamp = Date.now();
    const stored: Array<{ kind: string; file: File; path: string; url: string | undefined; index: number }> = [];
    for (const [i, u] of uploads.entries()) {
      const path = `agreements/${dealerId}/files/${stamp}-${i + 1}-${u.kind}.pdf`;
      stored.push({ kind: u.kind, file: u.file, path, url: await storeAgreementPdf(path, u.buffer), index: i });
    }
    const documentRows = (status: "accepted" | "pending_approval", overrideRequestId: string | null) =>
      stored.map((f) => ({
        application_id: dealerId,
        kind: f.kind,
        file_name: f.file.name,
        byte_size: f.file.size,
        storage_bucket: AGREEMENT_BUCKET,
        storage_path: f.path,
        file_url: f.url ?? null,
        extracted: extracted[f.index] ?? {},
        verdict: check.verdict,
        reasons: check.reasons,
        uploaded_by: auth.user.id,
        status,
        override_request_id: overrideRequestId,
      }));
    const actorEmail = auth.user.email ?? null;
    const eventBase = {
      source: "admin_manual_upload",
      actorEmail,
      signedAgreementFiles: signedFiles.map((f) => f.name),
      auditTrailFiles: auditFiles.map((f) => f.name),
      // E-225 — distinguishes "this dealer type always signs on paper" from
      // "a Digio e-sign that had to be finished by hand".
      agreementMode: isManualMode ? "manual" : "esign",
      dealerType: application.dealer_type ?? null,
    };

    // ─── not verified → ask for a second approval (E-318) ─────────────────
    if (check.verdict !== "verified") {
      let requestId: string;
      try {
        requestId = await db.transaction(async (tx) => {
          const [request] = await tx
            .insert(dealerAgreementOverrideRequests)
            .values({
              application_id: dealerId,
              add_only: alreadyCompleted,
              provider_document_id: application.provider_document_id,
              verdict: check.verdict,
              reasons: check.reasons,
              read_values: read,
              typed_signed_on: typedSignedOn,
              typed_ref: typedRef,
              request_reason: requestReason,
              requested_by: auth.user.id,
            })
            .returning({ id: dealerAgreementOverrideRequests.id });
          await tx.insert(dealerAgreementDocuments).values(documentRows("pending_approval", request.id));
          await tx.insert(dealerAgreementEvents).values({
            application_id: application.id,
            provider_document_id: application.provider_document_id,
            request_id: application.request_id,
            event_type: "manual_override_requested",
            event_status: "pending_approval",
            event_payload: {
              ...eventBase,
              overrideRequestId: request.id,
              requestedBy: auth.user.id,
              requestReason,
              typed: { signedOn: typedSignedOn, referenceNumber: typedRef },
              verification: { verdict: check.verdict, reasons: check.reasons, ...read },
            },
          });
          return request.id;
        });
      } catch (err) {
        if (isMissingSchemaError(err)) {
          return NextResponse.json({ success: false, message: MIGRATION_MISSING_MESSAGE }, { status: 503 });
        }
        if (hasPgCode(err, "23505")) {
          return NextResponse.json(
            {
              success: false,
              message:
                "An upload for this dealer is already waiting for a second approval. It has to be approved, rejected or withdrawn first.",
            },
            { status: 409 }
          );
        }
        throw err;
      }

      // Bell + email to every other active Sales Head / CEO — the only people
      // who can decide it. The request is already committed and shows on the
      // review page; emit() never throws, and the cap keeps a slow mail
      // gateway from stalling the response.
      await Promise.race([
        notifyAgreementApprovalRequested({
          dealerId,
          businessName: application.company_name,
          requestId,
          requesterId: auth.user.id,
          requestReason,
          reasons: check.reasons,
        }),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);

      return NextResponse.json(
        {
          success: true,
          pendingApproval: true,
          overrideRequestId: requestId,
          message:
            "Sent for a second approval. The documents are stored, but the agreement is not marked completed until another Sales Head or the CEO approves them.",
          agreementStatus: application.agreement_status,
          verification: { verdict: check.verdict, reasons: check.reasons },
        },
        { status: 202 }
      );
    }

    // ─── verified → on record now ─────────────────────────────────────────
    const firstSigned = uploads.find((u) => u.kind === "signed_agreement");
    const firstAudit = uploads.find((u) => u.kind === "audit_trail");
    let signedAgreementUrl: string | undefined;
    let auditTrailUrl: string | undefined;
    // Canonical copies: always on first completion; afterwards only to fill a
    // gap (a paper dealer adding their first trail), never to overwrite.
    if (firstSigned && !alreadyCompleted) {
      signedAgreementUrl = await storeAgreementPdf(signedAgreementPath(dealerId), firstSigned.buffer);
    }
    const fillAudit = !!firstAudit && (!alreadyCompleted || !application.audit_trail_storage_path);
    if (fillAudit && firstAudit) {
      auditTrailUrl = await storeAgreementPdf(auditTrailPath(dealerId), firstAudit.buffer);
    }

    const now = new Date();
    // Verified means the documents carry the date, and that anything typed
    // agrees with them — so the documents are what gets written. A typed
    // reference is used only when the paper shows none.
    const signedOn = check.signedOn;
    const agreementRef = check.referenceNumber ?? typedRef;
    const agreementRefSource = check.referenceNumber ? "document" : typedRef ? "typed" : null;

    try {
      await db.transaction(async (tx) => {
        if (!alreadyCompleted) {
          await tx
            .update(dealerOnboardingApplications)
            .set(
              agreementCompletionValues(application, {
                manualMode: isManualMode,
                signedOn,
                agreementRef,
                signedAgreementUrl,
                auditTrailUrl,
                auditStored: fillAudit,
                now,
              })
            )
            .where(eq(dealerOnboardingApplications.id, dealerId));
        } else if (fillAudit) {
          await tx
            .update(dealerOnboardingApplications)
            .set({
              audit_trail_url: auditTrailUrl || application.audit_trail_url,
              audit_trail_storage_path: auditTrailPath(dealerId),
              updated_at: now,
            })
            .where(eq(dealerOnboardingApplications.id, dealerId));
        }

        await tx.insert(dealerAgreementDocuments).values(documentRows("accepted", null));

        // Timeline breadcrumb: the completion was a manual upload, not a
        // Digio-synced event.
        await tx.insert(dealerAgreementEvents).values({
          application_id: application.id,
          provider_document_id: application.provider_document_id,
          request_id: application.request_id,
          event_type: alreadyCompleted ? "manual_documents_added" : "manual_completion",
          event_status: "completed",
          event_payload: {
            ...eventBase,
            agreementRef,
            agreementRefSource,
            agreementSignedOn: signedOn,
            // ID 55 — what the system read and that it matched.
            verification: { verdict: check.verdict, reasons: check.reasons, ...read },
          },
        });
      });
    } catch (err) {
      if (isMissingSchemaError(err)) {
        return NextResponse.json({ success: false, message: MIGRATION_MISSING_MESSAGE }, { status: 503 });
      }
      throw err;
    }

    // ID 84.2: the lead's agreement milestone, once the completion has
    // committed. A signed copy uploaded by hand reads "Manual agreement on
    // file" (ID 84.1). Best-effort — never throws.
    if (!alreadyCompleted) {
      await markAgreementOutcome({ applicationId: dealerId }, "manual_on_file");
    }

    return NextResponse.json({
      success: true,
      message: alreadyCompleted
        ? `${uploads.length} document(s) read, matched and added to the agreement.`
        : `Documents read and matched${signedOn ? ` — signed on ${signedOn}` : ""}. Agreement marked completed — you can now approve the dealer.`,
      agreementStatus: "completed",
      agreementMode: isManualMode ? "manual" : "esign",
      verification: { verdict: check.verdict, reasons: check.reasons, signedOn, documentId: check.documentId },
      signedAgreementUrl,
      auditTrailUrl,
    });
  } catch (error: unknown) {
    console.error("UPLOAD SIGNED AGREEMENT ERROR:", error);
    return NextResponse.json(
      { success: false, message: (error instanceof Error && error.message) || "Failed to save documents" },
      { status: 500 }
    );
  }
}

function hasPgCode(err: unknown, code: string): boolean {
  const seen = new Set<unknown>();
  let e = err as { code?: string; cause?: unknown } | null | undefined;
  while (e && !seen.has(e)) {
    seen.add(e);
    if (e.code === code) return true;
    e = e.cause as typeof e;
  }
  return false;
}
