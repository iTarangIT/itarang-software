export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  dealerAgreementDocuments,
  dealerAgreementEvents,
  dealerAgreementOverrideRequests,
  dealerOnboardingApplications,
} from "@/lib/db/schema";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import { normalizeAgreementStatus } from "@/lib/agreement/status";
import { usesManualAgreement } from "@/lib/dealer/dealer-capabilities";
import { notifyAgreementApprovalDecided } from "@/lib/notifications/events";
import { markAgreementOutcome } from "@/lib/onboarding/leadMilestones";
import {
  MIGRATION_MISSING_MESSAGE,
  agreementCompletionValues,
  auditTrailPath,
  isMissingSchemaError,
  readAgreementPdf,
  signedAgreementPath,
  storeAgreementPdf,
} from "@/lib/agreement/executedAgreementStore";

type RouteContext = {
  params: Promise<{ dealerId: string; requestId: string }>;
};

const bodySchema = z.object({
  action: z.enum(["approve", "reject", "withdraw"]),
  note: z.string().trim().max(1000).optional(),
});

/** Thrown inside the transaction when someone else decided the request first. */
class AlreadyDecided extends Error {}

/**
 * Decide a manual agreement upload that did not verify (tracker ID 55, E-318).
 *
 *   approve   a Sales Head / CEO who is NOT the uploader accepts the files.
 *             Only now is the agreement completed, from the request's own
 *             values (a typed date / reference wins — accepting it is exactly
 *             what the second person is doing).
 *   reject    the same second person refuses them; a note is required.
 *   withdraw  the uploader takes their own request back.
 *
 * The request, its files, the agreement status and the timeline event move in
 * ONE transaction, and the request row is claimed first (status = 'pending'),
 * so two approvers cannot both act on it.
 */
export async function POST(req: NextRequest, context: RouteContext) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;
  try {
    const { dealerId, requestId } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
      return NextResponse.json({ success: false, message: "Approval request not found" }, { status: 404 });
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, message: "Expected { action: approve | reject | withdraw, note? }." },
        { status: 400 }
      );
    }
    const { action } = parsed.data;
    const note = parsed.data.note || null;

    const [request] = await db
      .select()
      .from(dealerAgreementOverrideRequests)
      .where(
        and(
          eq(dealerAgreementOverrideRequests.id, requestId),
          eq(dealerAgreementOverrideRequests.application_id, dealerId)
        )
      )
      .limit(1);
    if (!request) {
      return NextResponse.json({ success: false, message: "Approval request not found" }, { status: 404 });
    }
    if (request.status !== "pending") {
      return NextResponse.json(
        { success: false, message: `This request was already ${request.status}.` },
        { status: 409 }
      );
    }

    const isRequester = request.requested_by === auth.user.id;
    if (action === "withdraw" && !isRequester) {
      return NextResponse.json(
        { success: false, message: "Only the person who sent this for approval can withdraw it." },
        { status: 403 }
      );
    }
    if (action !== "withdraw" && isRequester) {
      return NextResponse.json(
        {
          success: false,
          message: "You sent this for approval — another Sales Head or the CEO has to decide it.",
        },
        { status: 403 }
      );
    }
    if (action === "reject" && (note ?? "").length < 5) {
      return NextResponse.json(
        { success: false, message: "Give a reason for rejecting (at least 5 characters)." },
        { status: 400 }
      );
    }

    const [application] = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, dealerId))
      .limit(1);
    if (!application) {
      return NextResponse.json({ success: false, message: "Dealer application not found" }, { status: 404 });
    }

    const now = new Date();
    const actorEmail = auth.user.email ?? null;
    // Claims the request: zero rows back means someone else got there first.
    const claim = (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], status: string) =>
      tx
        .update(dealerAgreementOverrideRequests)
        .set({ status, decided_by: auth.user.id, decided_at: now, decision_note: note })
        .where(
          and(
            eq(dealerAgreementOverrideRequests.id, requestId),
            eq(dealerAgreementOverrideRequests.status, "pending")
          )
        )
        .returning({ id: dealerAgreementOverrideRequests.id });
    const eventRow = (eventType: string, eventStatus: string, extra: Record<string, unknown> = {}) => ({
      application_id: application.id,
      provider_document_id: application.provider_document_id,
      request_id: application.request_id,
      event_type: eventType,
      event_status: eventStatus,
      event_payload: {
        source: "admin_manual_upload",
        actorEmail,
        overrideRequestId: requestId,
        requestedBy: request.requested_by,
        requestReason: request.request_reason,
        decidedBy: auth.user.id,
        decisionNote: note,
        verification: { verdict: request.verdict, reasons: request.reasons },
        ...extra,
      },
    });

    // ─── reject / withdraw ────────────────────────────────────────────────
    if (action !== "approve") {
      const status = action === "reject" ? "rejected" : "withdrawn";
      await db.transaction(async (tx) => {
        if ((await claim(tx, status)).length === 0) throw new AlreadyDecided();
        await tx
          .update(dealerAgreementDocuments)
          .set({ status: "rejected" })
          .where(eq(dealerAgreementDocuments.override_request_id, requestId));
        await tx
          .insert(dealerAgreementEvents)
          .values(eventRow(`manual_override_${status}`, status));
      });
      // The uploader hears a rejection; a withdrawal is their own act.
      if (action === "reject") {
        await notifyAgreementApprovalDecided({
          dealerId,
          businessName: application.company_name,
          requestId,
          requesterId: request.requested_by,
          decision: "rejected",
          addOnly: request.add_only,
          note,
        });
      }
      return NextResponse.json({
        success: true,
        message:
          action === "reject"
            ? "Request rejected. The agreement is unchanged."
            : "Request withdrawn. The agreement is unchanged.",
      });
    }

    // ─── approve ──────────────────────────────────────────────────────────
    if (application.onboarding_status === "rejected") {
      return NextResponse.json(
        { success: false, message: "This application is rejected and locked." },
        { status: 400 }
      );
    }

    // The upload was read against one Digio document. If the agreement was
    // cancelled or re-initiated since, these files belong to the old one.
    if ((request.provider_document_id ?? null) !== (application.provider_document_id ?? null)) {
      return NextResponse.json(
        {
          success: false,
          message:
            "The agreement was re-initiated after this upload was sent for approval. Reject this request and upload the documents of the current agreement.",
        },
        { status: 409 }
      );
    }

    const files = await db
      .select()
      .from(dealerAgreementDocuments)
      .where(eq(dealerAgreementDocuments.override_request_id, requestId))
      .orderBy(asc(dealerAgreementDocuments.uploaded_at), asc(dealerAgreementDocuments.storage_path));
    const firstSigned = files.find((f) => f.kind === "signed_agreement");
    const firstAudit = files.find((f) => f.kind === "audit_trail");

    // Judged NOW, not when the request was made: Digio (or a verified upload)
    // may have completed the agreement in the meantime, and then these files
    // are only added to it.
    const alreadyCompleted = normalizeAgreementStatus(application.agreement_status) === "completed";
    const isManualMode = usesManualAgreement(application.dealer_type);
    if (!alreadyCompleted && !firstSigned) {
      return NextResponse.json(
        {
          success: false,
          message:
            "This request has no signed agreement in it and the agreement is not completed — reject it and upload the signed agreement.",
        },
        { status: 409 }
      );
    }

    // Promote the request's files to the canonical keys the download routes
    // and the welcome email read. Same rule as a verified upload: always on
    // first completion, afterwards only to fill a missing audit trail.
    const promote = async (file: (typeof files)[number], path: string) => {
      const buffer = await readAgreementPdf(file.storage_bucket, file.storage_path);
      if (!buffer) throw new Error(`"${file.file_name ?? file.storage_path}" is no longer in storage.`);
      return storeAgreementPdf(path, buffer);
    };
    let signedAgreementUrl: string | undefined;
    let auditTrailUrl: string | undefined;
    if (firstSigned && !alreadyCompleted) {
      signedAgreementUrl = await promote(firstSigned, signedAgreementPath(dealerId));
    }
    const fillAudit = !!firstAudit && (!alreadyCompleted || !application.audit_trail_storage_path);
    if (fillAudit && firstAudit) {
      auditTrailUrl = await promote(firstAudit, auditTrailPath(dealerId));
    }

    const readValues = (request.read_values ?? {}) as { signedOn?: string | null; referenceNumber?: string | null };
    const signedOn = request.typed_signed_on ?? readValues.signedOn ?? null;
    const agreementRef = request.typed_ref ?? readValues.referenceNumber ?? null;

    await db.transaction(async (tx) => {
      if ((await claim(tx, "approved")).length === 0) throw new AlreadyDecided();

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

      await tx
        .update(dealerAgreementDocuments)
        .set({ status: "accepted" })
        .where(eq(dealerAgreementDocuments.override_request_id, requestId));

      await tx.insert(dealerAgreementEvents).values(
        eventRow(alreadyCompleted ? "manual_documents_added" : "manual_completion", "completed", {
          agreementMode: isManualMode ? "manual" : "esign",
          dealerType: application.dealer_type ?? null,
          signedAgreementFiles: files.filter((f) => f.kind === "signed_agreement").map((f) => f.file_name),
          auditTrailFiles: files.filter((f) => f.kind === "audit_trail").map((f) => f.file_name),
          agreementRef,
          agreementSignedOn: signedOn,
          // The second person accepted documents the system could not verify.
          secondApproval: true,
        })
      );
    });

    // ID 84.2: the lead's agreement milestone, as on a verified upload.
    // Best-effort — never throws.
    if (!alreadyCompleted) {
      await markAgreementOutcome({ applicationId: dealerId }, "completed");
    }

    await notifyAgreementApprovalDecided({
      dealerId,
      businessName: application.company_name,
      requestId,
      requesterId: request.requested_by,
      decision: "approved",
      addOnly: alreadyCompleted,
      note,
    });

    return NextResponse.json({
      success: true,
      message: alreadyCompleted
        ? "Approved — the documents were added to the agreement."
        : "Approved — agreement marked completed. The dealer can now be approved.",
      agreementStatus: "completed",
    });
  } catch (error: unknown) {
    if (error instanceof AlreadyDecided) {
      return NextResponse.json(
        { success: false, message: "Someone else has just decided this request. Reload the page." },
        { status: 409 }
      );
    }
    if (isMissingSchemaError(error)) {
      return NextResponse.json({ success: false, message: MIGRATION_MISSING_MESSAGE }, { status: 503 });
    }
    console.error("AGREEMENT OVERRIDE DECISION ERROR:", error);
    return NextResponse.json(
      { success: false, message: (error instanceof Error && error.message) || "Failed to record the decision" },
      { status: 500 }
    );
  }
}
