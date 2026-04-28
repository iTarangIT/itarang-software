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
  isCorrectionDocumentKey,
  isCorrectionFieldKey,
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
// can see "you previously entered X" on the correction form.
function snapshotFieldValue(
  application: Record<string, unknown>,
  fieldKey: string,
): string | null {
  const value = application[fieldKey];
  if (value === undefined || value === null) return null;
  return String(value);
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
      .set({ status: "superseded", updatedAt: new Date() })
      .where(
        and(
          eq(dealerCorrectionRounds.applicationId, dealerId),
          inArray(dealerCorrectionRounds.status, ["pending", "submitted"]),
        ),
      );

    const latestRoundRow = await db
      .select({ roundNumber: dealerCorrectionRounds.roundNumber })
      .from(dealerCorrectionRounds)
      .where(eq(dealerCorrectionRounds.applicationId, dealerId))
      .orderBy(desc(dealerCorrectionRounds.roundNumber))
      .limit(1);
    const nextRoundNumber = (latestRoundRow[0]?.roundNumber ?? 0) + 1;

    // Resolve the most recent uploaded doc per requested type so the dealer
    // sees their previous file alongside the re-upload box.
    const previousDocsByType = new Map<string, string>();
    if (requestedDocuments.length > 0) {
      const docRows = await db
        .select({
          id: dealerOnboardingDocuments.id,
          documentType: dealerOnboardingDocuments.documentType,
          uploadedAt: dealerOnboardingDocuments.uploadedAt,
        })
        .from(dealerOnboardingDocuments)
        .where(
          and(
            eq(dealerOnboardingDocuments.applicationId, dealerId),
            inArray(
              dealerOnboardingDocuments.documentType,
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
        applicationId: dealerId,
        roundNumber: nextRoundNumber,
        status: "pending",
        requestedBy: auth.user.id,
        remarks,
        requestedFields,
        requestedDocuments,
        tokenHash,
        tokenExpiresAt,
      })
      .returning();

    const itemRows: Array<typeof dealerCorrectionItems.$inferInsert> = [];
    for (const fieldKey of requestedFields) {
      itemRows.push({
        roundId: round.id,
        kind: "field",
        key: fieldKey,
        previousValue: snapshotFieldValue(
          application as Record<string, unknown>,
          fieldKey,
        ),
      });
    }
    for (const docKey of requestedDocuments) {
      itemRows.push({
        roundId: round.id,
        kind: "document",
        key: docKey,
        previousDocumentId: previousDocsByType.get(docKey) ?? null,
      });
    }
    if (itemRows.length > 0) {
      await db.insert(dealerCorrectionItems).values(itemRows);
    }

    await db
      .update(dealerOnboardingApplications)
      .set({
        onboardingStatus: "correction_requested",
        reviewStatus: "under_correction",
        dealerAccountStatus: "inactive",
        completionStatus: "pending",
        correctionRemarks: remarks,
        updatedAt: new Date(),
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
      salesManagerEmail: maskEmail(application.salesManagerEmail),
      itarangSignatory1Email: maskEmail(application.itarangSignatory1Email),
      itarangSignatory2Email: maskEmail(application.itarangSignatory2Email),
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
          companyName: application.companyName || "Unknown Company",
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
