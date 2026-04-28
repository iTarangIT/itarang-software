import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/index";
import {
  dealerCorrectionItems,
  dealerCorrectionRounds,
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
} from "@/lib/db/schema";
import { hashCorrectionToken } from "@/lib/onboarding/correction-token";
import {
  documentLabel,
  fieldLabel,
  isCorrectionDocumentKey,
  isCorrectionFieldKey,
} from "@/lib/onboarding/correction-catalog";

// Public, token-authenticated endpoints used by the dealer correction form.
// No Supabase auth — middleware already lets /api/* through unauthenticated;
// security here is the 32-byte random token (sha256-hashed in DB).

type RouteContext = {
  params: Promise<{ token: string }>;
};

function badRequest(message: string, status = 400) {
  return NextResponse.json({ success: false, message }, { status });
}

async function loadRoundByToken(rawToken: string) {
  if (!rawToken || typeof rawToken !== "string") return null;
  const tokenHash = hashCorrectionToken(rawToken);
  const rows = await db
    .select()
    .from(dealerCorrectionRounds)
    .where(eq(dealerCorrectionRounds.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const { token } = await context.params;
    const round = await loadRoundByToken(token);

    if (!round) return badRequest("Invalid correction link", 404);

    if (round.tokenExpiresAt && new Date(round.tokenExpiresAt).getTime() < Date.now()) {
      return NextResponse.json({
        success: false,
        state: "expired",
        message: "This correction link has expired. Please contact iTarang.",
      });
    }

    if (round.status === "superseded") {
      return NextResponse.json({
        success: false,
        state: "superseded",
        message:
          "A newer correction request has been issued — please use the latest email.",
      });
    }

    if (round.status === "submitted" || round.status === "applied") {
      return NextResponse.json({
        success: false,
        state: "already_submitted",
        message:
          "Your corrections have already been submitted. We'll be in touch shortly.",
      });
    }

    const [application] = await db
      .select({
        id: dealerOnboardingApplications.id,
        companyName: dealerOnboardingApplications.companyName,
      })
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, round.applicationId))
      .limit(1);

    if (!application) return badRequest("Application not found", 404);

    const items = await db
      .select()
      .from(dealerCorrectionItems)
      .where(eq(dealerCorrectionItems.roundId, round.id));

    const previousDocIds = items
      .map((it) => it.previousDocumentId)
      .filter((v): v is string => !!v);

    const previousDocs =
      previousDocIds.length > 0
        ? await db
            .select({
              id: dealerOnboardingDocuments.id,
              documentType: dealerOnboardingDocuments.documentType,
              fileName: dealerOnboardingDocuments.fileName,
              fileUrl: dealerOnboardingDocuments.fileUrl,
              uploadedAt: dealerOnboardingDocuments.uploadedAt,
            })
            .from(dealerOnboardingDocuments)
            .where(inArray(dealerOnboardingDocuments.id, previousDocIds))
        : [];
    const previousDocsById = new Map(previousDocs.map((d) => [d.id, d]));

    const responseItems = items.map((it) => {
      const previousDoc = it.previousDocumentId
        ? previousDocsById.get(it.previousDocumentId) ?? null
        : null;
      return {
        id: it.id,
        kind: it.kind,
        key: it.key,
        label: it.kind === "field" ? fieldLabel(it.key) : documentLabel(it.key),
        previousValue: it.previousValue,
        previousDocument: previousDoc
          ? {
              fileName: previousDoc.fileName,
              fileUrl: previousDoc.fileUrl,
              uploadedAt: previousDoc.uploadedAt,
            }
          : null,
      };
    });

    return NextResponse.json({
      success: true,
      state: "ready",
      data: {
        applicationId: application.id,
        companyName: application.companyName,
        roundNumber: round.roundNumber,
        remarks: round.remarks,
        expiresAt: round.tokenExpiresAt,
        items: responseItems,
      },
    });
  } catch (error: any) {
    console.error("CORRECTION GET ERROR:", error);
    return NextResponse.json(
      { success: false, message: error?.message || "Error" },
      { status: 500 },
    );
  }
}

type SubmitDocumentInput = {
  documentType?: unknown;
  bucketName?: unknown;
  storagePath?: unknown;
  fileUrl?: unknown;
  fileName?: unknown;
  mimeType?: unknown;
  fileSize?: unknown;
};

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const { token } = await context.params;
    const round = await loadRoundByToken(token);

    if (!round) return badRequest("Invalid correction link", 404);

    if (round.tokenExpiresAt && new Date(round.tokenExpiresAt).getTime() < Date.now()) {
      return badRequest("This correction link has expired", 410);
    }
    if (round.status !== "pending") {
      return badRequest(
        "This correction request is no longer accepting submissions",
        409,
      );
    }

    const body = await req.json().catch(() => ({}));
    const fieldUpdatesRaw = (body?.fieldUpdates ?? {}) as Record<string, unknown>;
    const documentUpdatesRaw = Array.isArray(body?.documentUpdates)
      ? (body.documentUpdates as SubmitDocumentInput[])
      : [];
    const dealerNote = cleanString(body?.dealerNote) || null;

    const requestedFieldSet = new Set(round.requestedFields ?? []);
    const requestedDocumentSet = new Set(round.requestedDocuments ?? []);

    const items = await db
      .select()
      .from(dealerCorrectionItems)
      .where(eq(dealerCorrectionItems.roundId, round.id));

    // ── Validate field updates ──────────────────────────────────────────────
    const fieldUpdates: Record<string, string> = {};
    for (const [key, rawValue] of Object.entries(fieldUpdatesRaw)) {
      if (!isCorrectionFieldKey(key) || !requestedFieldSet.has(key)) continue;
      const value = cleanString(rawValue);
      if (!value) {
        return badRequest(`Please fill in: ${fieldLabel(key)}`);
      }
      fieldUpdates[key] = value;
    }

    // Every requested field must have a value.
    for (const requiredKey of requestedFieldSet) {
      if (!(requiredKey in fieldUpdates)) {
        return badRequest(`Missing field: ${fieldLabel(requiredKey)}`);
      }
    }

    // ── Validate document updates ───────────────────────────────────────────
    const sanitizedDocs: Array<{
      documentType: string;
      bucketName: string;
      storagePath: string;
      fileUrl: string | null;
      fileName: string;
      mimeType: string | null;
      fileSize: number | null;
    }> = [];

    for (const doc of documentUpdatesRaw) {
      const documentType = cleanString(doc.documentType);
      if (!isCorrectionDocumentKey(documentType)) continue;
      if (!requestedDocumentSet.has(documentType)) continue;

      const bucketName = cleanString(doc.bucketName);
      const storagePath = cleanString(doc.storagePath);
      const fileName = cleanString(doc.fileName);
      const fileUrl = cleanString(doc.fileUrl) || null;
      const mimeType = cleanString(doc.mimeType) || null;
      const fileSize =
        typeof doc.fileSize === "number" && Number.isFinite(doc.fileSize)
          ? doc.fileSize
          : null;

      if (!bucketName || !storagePath || !fileName) {
        return badRequest(
          `Re-upload appears incomplete for: ${documentLabel(documentType)}`,
        );
      }
      sanitizedDocs.push({
        documentType,
        bucketName,
        storagePath,
        fileName,
        fileUrl,
        mimeType,
        fileSize,
      });
    }

    const submittedDocTypes = new Set(sanitizedDocs.map((d) => d.documentType));
    for (const requiredKey of requestedDocumentSet) {
      if (!submittedDocTypes.has(requiredKey)) {
        return badRequest(`Missing document: ${documentLabel(requiredKey)}`);
      }
    }

    // ── Persist new docs, then link to items, then update field newValues ──
    if (sanitizedDocs.length > 0) {
      const inserted = await db
        .insert(dealerOnboardingDocuments)
        .values(
          sanitizedDocs.map((d) => ({
            applicationId: round.applicationId,
            documentType: d.documentType,
            bucketName: d.bucketName,
            storagePath: d.storagePath,
            fileName: d.fileName,
            fileUrl: d.fileUrl,
            mimeType: d.mimeType,
            fileSize: d.fileSize,
            docStatus: "pending_correction",
            verificationStatus: "pending",
            metadata: {
              source: "dealer_correction_submission",
              correctionRoundId: round.id,
            },
          })),
        )
        .returning({
          id: dealerOnboardingDocuments.id,
          documentType: dealerOnboardingDocuments.documentType,
        });

      const newDocIdByType = new Map(inserted.map((i) => [i.documentType, i.id]));

      for (const item of items) {
        if (item.kind !== "document") continue;
        const newId = newDocIdByType.get(item.key);
        if (!newId) continue;
        await db
          .update(dealerCorrectionItems)
          .set({ newDocumentId: newId })
          .where(eq(dealerCorrectionItems.id, item.id));
      }
    }

    for (const item of items) {
      if (item.kind !== "field") continue;
      const value = fieldUpdates[item.key];
      if (value === undefined) continue;
      await db
        .update(dealerCorrectionItems)
        .set({ newValue: value })
        .where(eq(dealerCorrectionItems.id, item.id));
    }

    await db
      .update(dealerCorrectionRounds)
      .set({
        status: "submitted",
        dealerSubmittedAt: new Date(),
        dealerNote,
        updatedAt: new Date(),
      })
      .where(eq(dealerCorrectionRounds.id, round.id));

    return NextResponse.json({
      success: true,
      message: "Correction submitted",
    });
  } catch (error: any) {
    console.error("CORRECTION POST ERROR:", error);
    return NextResponse.json(
      { success: false, message: error?.message || "Error" },
      { status: 500 },
    );
  }
}
