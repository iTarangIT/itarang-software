// GET /api/admin/whatsapp-onboarding/conversations/[applicationId]
//
// Everything captured for one WhatsApp prospect so far — the point being that
// "so far" can mean "one document and nothing else". Documents are persisted the
// moment each file arrives (insertDocRow, orchestrator.ts), so there is always
// something to show well before the dealer confirms and submits.

import { and, desc, eq, inArray, notInArray } from "drizzle-orm";

import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
  whatsappOnboardingSessions,
  whatsappOperators,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import {
  errorResponse,
  successResponse,
  withErrorHandler,
} from "@/lib/api-utils";
import {
  type CompanyType,
  docTypeLabel,
  requiredDocuments,
} from "@/lib/whatsapp/checklist";
import { buildCapturedDetails } from "@/lib/whatsapp/captured-details";
import { isPlaceholderCompany, prospectDisplayName } from "@/lib/whatsapp/labels";
import {
  activityOf,
  contactTypeOf,
  CONTACT_TYPE_LABEL,
  stageLabel,
  stageOf,
} from "@/lib/whatsapp/stage";
import type { Ctx } from "@/lib/whatsapp/session-store";

const READ_ROLES = ["admin", "sales_head", "ceo"];

export const GET = withErrorHandler(
  async (
    _req: Request,
    ctx: { params: Promise<{ applicationId: string }> },
  ) => {
    await requireRole(READ_ROLES);
    const { applicationId } = await ctx.params;
    if (!applicationId) return errorResponse("Application id required", 400);

    const [application] = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, applicationId))
      .limit(1);

    if (!application) return errorResponse("Conversation not found", 404);
    // Keep this endpoint to WhatsApp-collected files so it can't become a second
    // way to read web onboarding applications.
    if ((application.source ?? "").toLowerCase() !== "whatsapp") {
      return errorResponse("Not a WhatsApp onboarding conversation", 404);
    }

    const sessionIds = [
      application.wa_session_id,
      application.wa_operator_session_id,
    ].filter((id): id is string => Boolean(id));

    const [documents, sessions, operatorRow] = await Promise.all([
      db
        .select()
        .from(dealerOnboardingDocuments)
        .where(
          and(
            eq(dealerOnboardingDocuments.application_id, applicationId),
            notInArray(dealerOnboardingDocuments.doc_status, [
              "superseded",
              "pending_correction",
            ]),
          ),
        )
        .orderBy(desc(dealerOnboardingDocuments.uploaded_at)),
      sessionIds.length
        ? db
            .select()
            .from(whatsappOnboardingSessions)
            .where(inArray(whatsappOnboardingSessions.id, sessionIds))
        : Promise.resolve([]),
      application.onboarding_operator_id
        ? db
            .select({
              id: whatsappOperators.id,
              displayName: whatsappOperators.display_name,
              waPhone: whatsappOperators.wa_phone,
            })
            .from(whatsappOperators)
            .where(eq(whatsappOperators.id, application.onboarding_operator_id))
            .limit(1)
        : Promise.resolve([]),
    ]);

    const dealerSession =
      sessions.find((s) => s.id === application.wa_session_id) ?? null;
    const operatorSession =
      sessions.find((s) => s.id === application.wa_operator_session_id) ?? null;

    const sessionCtx = ((dealerSession?.context ??
      operatorSession?.context ??
      {}) as Ctx) ?? {};

    const currentState =
      dealerSession?.current_state ?? operatorSession?.current_state ?? null;
    const lastInboundAt =
      dealerSession?.last_inbound_at ?? operatorSession?.last_inbound_at ?? null;

    const resolvedStage = stageOf({
      currentState,
      onboardingStatus: application.onboarding_status,
      reviewStatus: application.review_status,
    });

    const contactType = contactTypeOf({
      currentState,
      flow: (sessionCtx as { flow?: string }).flow ?? null,
      companyType: application.company_type,
      onboardingStatus: application.onboarding_status,
    });

    // Latest upload per type — a dealer who re-sent a document should show one
    // fresh card, not a history.
    const latestPerType = new Map<string, (typeof documents)[number]>();
    for (const doc of documents) {
      const prior = latestPerType.get(doc.document_type);
      if (
        !prior ||
        new Date(doc.uploaded_at).getTime() >
          new Date(prior.uploaded_at).getTime()
      ) {
        latestPerType.set(doc.document_type, doc);
      }
    }

    const required = requiredDocuments(
      application.company_type as CompanyType | null,
    );
    const uploadedTypes = new Set(latestPerType.keys());

    return successResponse({
      application: {
        applicationId: application.id,
        contactType,
        contactTypeLabel: CONTACT_TYPE_LABEL[contactType],
        displayName: prospectDisplayName({
          companyName: application.company_name,
          ownerName: application.owner_name,
          contactName: dealerSession?.wa_contact_name ?? null,
          waPhone: application.wa_phone,
        }),
        companyName: isPlaceholderCompany(application.company_name)
          ? null
          : application.company_name,
        companyType: application.company_type,
        dealerType: application.dealer_type,
        waPhone: application.wa_phone,
        onboardingStatus: application.onboarding_status,
        reviewStatus: application.review_status,
        agreementStatus: application.agreement_status,
        dealerCode: application.dealer_code,
        financeEnabled: application.finance_enabled,
        channel: application.onboarding_channel ?? "self",
        firstContactAt: application.created_at,
        submittedAt: application.submitted_at,
        approvedAt: application.approved_at,
        lastInboundAt,
        activity: activityOf(lastInboundAt),
        stage: resolvedStage,
        stageLabel: stageLabel(resolvedStage),
        currentState,
        operator: operatorRow[0] ?? null,
        warnings: Array.isArray(application.verification_warnings)
          ? application.verification_warnings
          : [],
        extractionSummary: application.extraction_summary ?? null,
      },
      sessions: sessions.map((s) => ({
        id: s.id,
        kind: s.session_kind,
        waPhone: s.wa_phone,
        waContactName: s.wa_contact_name,
        currentState: s.current_state,
        sessionStatus: s.session_status,
        language: s.language,
        detectedCompanyType: s.detected_company_type,
        expectedDocumentType: s.expected_document_type,
        createdAt: s.created_at,
        lastInboundAt: s.last_inbound_at,
        lastOutboundAt: s.last_outbound_at,
        // Labels the transcript button so an admin knows whose chat they open.
        role: s.id === application.wa_operator_session_id ? "operator" : "dealer",
      })),
      captured: buildCapturedDetails(
        application as unknown as Record<string, unknown>,
        sessionCtx,
      ),
      documents: Array.from(latestPerType.values()).map((doc) => ({
        id: doc.id,
        documentType: doc.document_type,
        label: docTypeLabel(doc.document_type),
        fileUrl: doc.file_url,
        fileName: doc.file_name,
        mimeType: doc.mime_type,
        fileSize: doc.file_size,
        docStatus: doc.doc_status,
        verificationStatus: doc.verification_status,
        uploadedAt: doc.uploaded_at,
        extractedFields: (doc.extracted_data ?? {}) as Record<string, unknown>,
        extractionConfidence: doc.extraction_confidence,
        verificationProvider: doc.verification_provider,
        source: doc.source,
      })),
      checklist: required.map((d) => ({
        type: d.type,
        label: d.label,
        uploaded: uploadedTypes.has(d.type),
      })),
      progress: {
        stage: resolvedStage,
        stageLabel: stageLabel(resolvedStage),
        docsUploaded: uploadedTypes.size,
        docsRequired: required.length,
      },
      // Documents the dealer couldn't provide, so an admin can chase them.
      skipped: (sessionCtx.skipped ?? []).map((t) => ({
        type: t,
        label: docTypeLabel(t),
      })),
    });
  },
);
