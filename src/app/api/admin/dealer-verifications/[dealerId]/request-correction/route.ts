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
  FIELD_KEY_TO_COLUMN,
  documentLabel,
  fieldLabel,
  isCorrectionDocumentKey,
  isCorrectionFieldKey,
  type CorrectionFieldKey,
} from "@/lib/onboarding/correction-catalog";
import {
  buildCorrectionLink,
  correctionTokenExpiry,
  generateCorrectionToken,
} from "@/lib/onboarding/correction-token";

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

// Snapshot the current value of a field on the application row so the dealer
// can see "you previously entered X" on the correction form. Catalog keys are
// camelCase but the Drizzle row uses snake_case property names, so we look up
// the column name via FIELD_KEY_TO_COLUMN before reading.
function snapshotFieldValue(
  application: Record<string, unknown>,
  fieldKey: string,
): string | null {
  const column = FIELD_KEY_TO_COLUMN[fieldKey as CorrectionFieldKey];
  if (!column) return null;
  const value = application[column];
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  return str.length > 0 ? str : null;
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
    // sees their previous file alongside the re-upload box.
    const previousDocsByType = new Map<string, string>();
    if (requestedDocuments.length > 0) {
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
            inArray(
              dealerOnboardingDocuments.document_type,
              requestedDocuments,
            ),
          ),
        );

      // Keep the most recent doc per type.
      for (const doc of docRows) {
        const existing = previousDocsByType.get(doc.documentType);
        if (!existing) {
          previousDocsByType.set(doc.documentType, doc.id);
          continue;
        }
        // Compare against the existing winner; pick whichever uploaded later.
        const winner = docRows.find((d) => d.id === existing);
        if (
          winner &&
          new Date(doc.uploadedAt).getTime() >
            new Date(winner.uploadedAt).getTime()
        ) {
          previousDocsByType.set(doc.documentType, doc.id);
        }
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

    return NextResponse.json({
      success: true,
      message: emailResult.ok
        ? "Correction request sent"
        : "Correction saved but email failed",
      roundId: round.id,
      roundNumber: nextRoundNumber,
      notificationRecipients,
      emailResult,
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
