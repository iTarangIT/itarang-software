import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/index";
import {
  dealerCorrectionItems,
  dealerCorrectionRounds,
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
} from "@/lib/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { sendDealerCorrectionNotificationEmail } from "@/lib/email/sendDealerCorrectionNotificationEmail";
import { getDealerNotificationRecipients } from "@/lib/email/dealer-notification-recipients";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import {
  CORRECTION_DOCUMENTS,
  CORRECTION_FIELDS,
  documentLabel,
  fieldLabel,
  fieldStore,
  isCorrectionDocumentKey,
  isCorrectionFieldKey,
} from "@/lib/onboarding/correction-catalog";
import {
  buildCorrectionLink,
  correctionTokenExpiry,
  generateCorrectionToken,
} from "@/lib/onboarding/correction-token";
import { CATALOG_TO_WHATSAPP_DOC } from "@/lib/whatsapp/correction-map";
import { startCorrectionOverWhatsApp } from "@/lib/whatsapp/orchestrator";
import { notifyOnboardingDecision } from "@/lib/notifications/events";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

function cleanString(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function toStr(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
}

function parseJson(value: unknown): Record<string, any> {
  if (value && typeof value === "object") return value as Record<string, any>;
  if (typeof value === "string") {
    const t = value.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try { return JSON.parse(t); } catch { return {}; }
    }
  }
  return {};
}

// The dealer's current address line out of the business_address TEXT column,
// which holds either a JSON { address } object or a plain string.
function readBusinessAddress(application: Record<string, unknown>): string | null {
  const raw = application.business_address;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t.startsWith("{")) return toStr(parseJson(t).address);
    return toStr(t);
  }
  if (raw && typeof raw === "object") return toStr((raw as Record<string, any>).address);
  return null;
}

function readOwnershipSnapshot(application: Record<string, unknown>, key: string): string | null {
  const provider = parseJson(application.provider_raw_response);
  const ownership = provider?.submissionSnapshot?.ownership;
  if (ownership && typeof ownership === "object") return toStr(ownership[key]);
  return null;
}

// Snapshot the current value of a field so the dealer sees "you previously
// entered X" on the correction form. Routes by where the field is stored:
// plain column, the business_address JSON, or the snapshot ownership object.
function snapshotFieldValue(
  application: Record<string, unknown>,
  fieldKey: string,
): string | null {
  const store = fieldStore(fieldKey);
  if (!store) return null;
  if (store.kind === "column") return toStr(application[store.column]);
  if (store.kind === "businessAddress") return readBusinessAddress(application);
  if (store.kind === "snapshotOwnership")
    return readOwnershipSnapshot(application, store.snapshotKey);
  return null;
}

export async function POST(req: NextRequest, context: RouteContext) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;
  try {
    const { dealerId } = await context.params;
    const body = await req.json().catch(() => ({}));

    const remarks = cleanString(body?.remarks);
    const requestedFields = uniqueStrings(body?.requestedFields).filter(
      isCorrectionFieldKey,
    );
    const requestedDocuments = uniqueStrings(body?.requestedDocuments).filter(
      isCorrectionDocumentKey,
    );

    if (!remarks) {
      return NextResponse.json(
        { success: false, message: "Correction remarks are required" },
        { status: 400 },
      );
    }

    if (requestedFields.length === 0 && requestedDocuments.length === 0) {
      return NextResponse.json(
        {
          success: false,
          message:
            "Select at least one field or document the dealer should correct",
        },
        { status: 400 },
      );
    }

    const applicationRows = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, dealerId))
      .limit(1);

    const application = applicationRows[0];

    if (!application) {
      return NextResponse.json(
        { success: false, message: "Application not found" },
        { status: 404 },
      );
    }

    // Mark any prior pending/submitted round as superseded so the dealer's old
    // magic link returns "this round is closed" and the admin panel only ever
    // shows the latest round.
    await db
      .update(dealerCorrectionRounds)
      .set({ status: "superseded", updated_at: new Date() })
      .where(
        and(
          eq(dealerCorrectionRounds.application_id, dealerId),
          inArray(dealerCorrectionRounds.status, ["pending", "submitted"]),
        ),
      );

    const latestRoundRow = await db
      .select({ roundNumber: dealerCorrectionRounds.round_number })
      .from(dealerCorrectionRounds)
      .where(eq(dealerCorrectionRounds.application_id, dealerId))
      .orderBy(desc(dealerCorrectionRounds.round_number))
      .limit(1);
    const nextRoundNumber = (latestRoundRow[0]?.roundNumber ?? 0) + 1;

    // Resolve the most recent uploaded doc per requested type so the dealer
    // sees their previous file alongside the re-upload box, and so apply-
    // correction can later supersede it by id. The catalog keys
    // (gst_certificate, …) are the WEB document types; WhatsApp-onboarded
    // dealers store the same docs under shorter types (gst, …), so for them we
    // query by the mapped WhatsApp type and key the result back to the catalog
    // key the round/items use.
    const isWhatsappDealer =
      (application.source || "web").toLowerCase() === "whatsapp";
    const previousDocsByType = new Map<string, string>();
    if (requestedDocuments.length > 0) {
      // catalog key → the document_type actually stored in the DB for this dealer.
      const requestedPairs = requestedDocuments.map((catalogKey) => ({
        catalogKey,
        dbType: isWhatsappDealer
          ? (CATALOG_TO_WHATSAPP_DOC as Record<string, string>)[catalogKey] ??
            catalogKey
          : catalogKey,
      }));
      const dbTypes = Array.from(new Set(requestedPairs.map((p) => p.dbType)));

      const docRows = await db
        .select({
          id: dealerOnboardingDocuments.id,
          documentType: dealerOnboardingDocuments.document_type,
          uploadedAt: dealerOnboardingDocuments.uploaded_at,
        })
        .from(dealerOnboardingDocuments)
        .where(
          and(
            eq(dealerOnboardingDocuments.application_id, dealerId),
            inArray(dealerOnboardingDocuments.document_type, dbTypes),
          ),
        );

      // For each requested item, pick the most recent doc of its DB type and
      // store it under the CATALOG key (what the correction item uses).
      for (const { catalogKey, dbType } of requestedPairs) {
        let winner: { id: string; uploadedAt: Date } | null = null;
        for (const doc of docRows) {
          if (doc.documentType !== dbType) continue;
          if (
            !winner ||
            new Date(doc.uploadedAt).getTime() >
              new Date(winner.uploadedAt).getTime()
          ) {
            winner = { id: doc.id, uploadedAt: doc.uploadedAt };
          }
        }
        if (winner) previousDocsByType.set(catalogKey, winner.id);
      }
    }

    const { rawToken, tokenHash } = generateCorrectionToken();
    const tokenExpiresAt = correctionTokenExpiry();

    const [round] = await db
      .insert(dealerCorrectionRounds)
      .values({
        application_id: dealerId,
        round_number: nextRoundNumber,
        status: "pending",
        requested_by: auth.user.id,
        remarks,
        requested_fields: requestedFields,
        requested_documents: requestedDocuments,
        token_hash: tokenHash,
        token_expires_at: tokenExpiresAt,
      })
      .returning();

    const itemRows: Array<typeof dealerCorrectionItems.$inferInsert> = [];
    for (const fieldKey of requestedFields) {
      itemRows.push({
        round_id: round.id,
        kind: "field",
        key: fieldKey,
        previous_value: snapshotFieldValue(
          application as Record<string, unknown>,
          fieldKey,
        ),
      });
    }
    for (const docKey of requestedDocuments) {
      itemRows.push({
        round_id: round.id,
        kind: "document",
        key: docKey,
        previous_document_id: previousDocsByType.get(docKey) ?? null,
      });
    }
    if (itemRows.length > 0) {
      await db.insert(dealerCorrectionItems).values(itemRows);
    }

    await db
      .update(dealerOnboardingApplications)
      .set({
        onboarding_status: "correction_requested",
        review_status: "under_correction",
        dealer_account_status: "inactive",
        completion_status: "pending",
        correction_remarks: remarks,
        updated_at: new Date(),
      })
      .where(eq(dealerOnboardingApplications.id, dealerId));

    const notificationRecipients = await getDealerNotificationRecipients(
      application,
      { includeDealer: true },
    );

    const correctionLink = buildCorrectionLink(rawToken, req);
    const requestedFieldLabels = requestedFields.map((k) => fieldLabel(k));
    const requestedDocumentLabels = requestedDocuments.map((k) =>
      documentLabel(k),
    );

    console.log("CORRECTION link:", correctionLink);

    const maskEmail = (e: unknown): string | null => {
      if (typeof e !== "string" || !e.includes("@")) return null;
      const [local, domain] = e.split("@");
      return `${local.charAt(0) || "*"}***@${domain}`;
    };
    console.log("CORRECTION recipients:", {
      dealerId,
      applicationId: application.id,
      roundId: round.id,
      roundNumber: nextRoundNumber,
      salesManagerEmail: maskEmail(application.sales_manager_email),
      itarangSignatory1Email: maskEmail(application.itarang_signatory_1_email),
      itarangSignatory2Email: maskEmail(application.itarang_signatory_2_email),
      notificationRecipientsCount: notificationRecipients.length,
    });

    let emailResult: {
      ok: boolean;
      messageId?: string;
      recipients?: string[];
      error?: string;
      message?: string;
    };
    if (notificationRecipients.length === 0) {
      console.warn("No correction notification recipients found for application:", {
        dealerId,
        applicationId: application.id,
      });
      emailResult = {
        ok: false,
        error: "no_recipients",
        message: "No notification recipients resolved for this application",
      };
    } else {
      try {
        emailResult = await sendDealerCorrectionNotificationEmail({
          toEmails: notificationRecipients,
          companyName: application.company_name || "Unknown Company",
          applicationId: String(application.id),
          correctionRemarks: remarks,
          correctionLink,
          requestedFieldLabels,
          requestedDocumentLabels,
        });
      } catch (emailError: any) {
        console.error("REQUEST CORRECTION EMAIL ERROR:", emailError);
        emailResult = {
          ok: false,
          error: "send_failed",
          message: emailError?.message || "Failed to send correction email",
        };
      }
    }

    // WhatsApp-onboarded dealers fix the flagged items IN the chat: flip their
    // session into CORRECTION mode and prompt the first item. Best-effort and
    // additive — the email above (with the web fallback link) still goes out.
    let whatsappCorrection: { ok: boolean; error?: string } | null = null;
    if (isWhatsappDealer && application.wa_phone) {
      try {
        whatsappCorrection = await startCorrectionOverWhatsApp({
          application: {
            id: String(application.id),
            wa_session_id: (application.wa_session_id as string | null) ?? null,
            wa_phone: application.wa_phone as string,
            // E-214 — route the correction to whichever channel owns the file.
            // For an operator-uploaded dealer the dealer's own number may never
            // have messaged us, so wa_session_id would be a dead end.
            onboarding_channel:
              (application.onboarding_channel as string | null) ?? null,
            wa_operator_session_id:
              (application.wa_operator_session_id as string | null) ?? null,
          },
          roundId: round.id,
          roundNumber: nextRoundNumber,
          remarks,
          requestedFields,
          requestedDocuments,
        });
      } catch (waErr: any) {
        whatsappCorrection = {
          ok: false,
          error: waErr?.message || "whatsapp_correction_error",
        };
        console.error("REQUEST CORRECTION — WhatsApp start threw:", waErr);
      }
      console.log("CORRECTION WHATSAPP:", { dealerId, whatsappCorrection });
    }

    // In-app row for the dealer's bell + an audit copy for the admins. The
    // correction EMAIL (and, for WhatsApp dealers, the in-chat prompt) already
    // went out above, so this sends no second email.
    await notifyOnboardingDecision({
      dealerId,
      businessName: application.company_name || "Your company",
      decision: "correction_requested",
      reason: [remarks, ...requestedFieldLabels, ...requestedDocumentLabels]
        .filter(Boolean)
        .join(" · "),
    });

    return NextResponse.json({
      success: true,
      message: emailResult.ok
        ? "Correction request sent"
        : "Correction saved but email failed",
      roundId: round.id,
      roundNumber: nextRoundNumber,
      notificationRecipients,
      emailResult,
      whatsappCorrection,
    });
  } catch (error: any) {
    console.error("REQUEST CORRECTION ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: error?.message || "Error",
      },
      { status: 500 },
    );
  }
}

// Re-export catalogs for any caller that wants the canonical list (the admin
// modal imports directly from the catalog module — this is just defensive).
export const _CATALOG = { CORRECTION_FIELDS, CORRECTION_DOCUMENTS };
