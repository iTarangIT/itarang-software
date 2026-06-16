export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerOnboardingApplications, dealerOnboardingDocuments } from "@/lib/db/schema";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import { removeMedia, saveMedia } from "@/lib/whatsapp/storage";

type RouteContext = { params: Promise<{ dealerId: string }> };

// Admin add/replace of a dealer onboarding document. Lets a sales head upload a
// missing document, or replace an existing one, directly from the review panel
// — independent of the dealer's WhatsApp/web upload flow.
//
//   POST multipart/form-data:
//     file          — the document (PDF / image), required
//     documentType  — the doc slot, e.g. "gst", "company_pan", required
//     mode          — "replace" (supersede the latest live doc of this type) or
//                     "add" (default; keep prior copies)
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

export async function POST(req: NextRequest, context: RouteContext) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;
  try {
    const { dealerId } = await context.params;

    const [application] = await db
      .select({
        id: dealerOnboardingApplications.id,
        onboardingStatus: dealerOnboardingApplications.onboarding_status,
      })
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, dealerId))
      .limit(1);

    if (!application) {
      return NextResponse.json(
        { success: false, message: "Dealer application not found" },
        { status: 404 }
      );
    }
    if (application.onboardingStatus === "rejected") {
      return NextResponse.json(
        { success: false, message: "This application is rejected and locked." },
        { status: 400 }
      );
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json(
        { success: false, message: "Expected multipart/form-data with a file upload." },
        { status: 400 }
      );
    }

    const file = form.get("file");
    const documentType = String(form.get("documentType") || "").trim();
    const mode = String(form.get("mode") || "add").trim().toLowerCase();

    if (!(file instanceof File)) {
      return NextResponse.json(
        { success: false, message: "A 'file' is required." },
        { status: 400 }
      );
    }
    if (!documentType) {
      return NextResponse.json(
        { success: false, message: "A 'documentType' is required." },
        { status: 400 }
      );
    }

    const mimeType = file.type || "application/octet-stream";
    if (!ALLOWED_MIME.has(mimeType)) {
      return NextResponse.json(
        { success: false, message: "Only PDF or image (JPG/PNG/WEBP) files are allowed." },
        { status: 400 }
      );
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.byteLength < 100) {
      return NextResponse.json(
        { success: false, message: "File is empty or corrupted." },
        { status: 400 }
      );
    }
    if (buffer.byteLength > MAX_BYTES) {
      return NextResponse.json(
        { success: false, message: "File exceeds the 20 MB limit." },
        { status: 400 }
      );
    }

    // Store the file (same bucket the rest of the app reads from).
    const saved = await saveMedia({
      buffer,
      mimeType,
      applicationId: dealerId,
      docType: documentType,
      fileName: file.name,
    });

    // Replace mode — supersede the latest LIVE doc(s) of this type and delete
    // their storage objects, so the review list shows a single fresh copy.
    if (mode === "replace") {
      const priorRows = await db
        .select({
          id: dealerOnboardingDocuments.id,
          bucket: dealerOnboardingDocuments.bucket_name,
          path: dealerOnboardingDocuments.storage_path,
        })
        .from(dealerOnboardingDocuments)
        .where(
          and(
            eq(dealerOnboardingDocuments.application_id, dealerId),
            eq(dealerOnboardingDocuments.document_type, documentType),
            notInArray(dealerOnboardingDocuments.doc_status, [
              "superseded",
              "pending_correction",
            ]),
          ),
        );
      if (priorRows.length) {
        await db
          .update(dealerOnboardingDocuments)
          .set({ doc_status: "superseded", updated_at: new Date() })
          .where(inArray(dealerOnboardingDocuments.id, priorRows.map((r) => r.id)));
        const byBucket = new Map<string, string[]>();
        for (const r of priorRows) {
          if (!r.path) continue;
          const arr = byBucket.get(r.bucket) ?? [];
          arr.push(r.path);
          byBucket.set(r.bucket, arr);
        }
        for (const [bucket, paths] of byBucket) await removeMedia(bucket, paths);
      }
    }

    const [inserted] = await db
      .insert(dealerOnboardingDocuments)
      .values({
        application_id: dealerId,
        document_type: documentType,
        bucket_name: saved.bucket,
        storage_path: saved.path,
        file_name: saved.fileName,
        file_url: saved.fileUrl,
        mime_type: mimeType,
        file_size: saved.fileSize,
        uploaded_by: auth.user.id,
        doc_status: "uploaded",
        verification_status: "pending",
        metadata: { uploaded_via: "admin_panel", mode },
        source: "admin",
      })
      .returning({
        id: dealerOnboardingDocuments.id,
        documentType: dealerOnboardingDocuments.document_type,
        fileUrl: dealerOnboardingDocuments.file_url,
        fileName: dealerOnboardingDocuments.file_name,
      });

    return NextResponse.json({
      success: true,
      message: mode === "replace" ? "Document replaced." : "Document added.",
      document: inserted,
    });
  } catch (error: any) {
    console.error("ADMIN UPLOAD DOCUMENT ERROR:", error);
    return NextResponse.json(
      { success: false, message: error?.message || "Failed to upload document" },
      { status: 500 }
    );
  }
}
