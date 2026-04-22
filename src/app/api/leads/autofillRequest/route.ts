export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auditLogs, leadDocuments } from "@/lib/db/schema";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { extractDocumentOcr } from "@/lib/decentro";
import {
  buildFinalData,
  extractStructuredAadhaar,
  hasUsefulData,
} from "@/lib/kyc/aadhaarNormalize";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { inArray } from "drizzle-orm";

const BUCKET = "private-documents";

// Decentro can return HTTP 200 with a failure payload (IP not whitelisted,
// credits exhausted, malformed image). Detect those so we can surface a
// clear error instead of silently auto-filling nothing.
function isDecentroFailure(response: any): boolean {
  if (!response) return true;
  if (response.status === "FAILURE" || response.ocrStatus === "FAILURE") return true;
  if (response.responseStatus && response.responseStatus !== "SUCCESS") return true;
  if (response.error?.responseCode) return true;
  if (response.message && !response.ocrResult && !response.data) return true;
  return false;
}

async function fetchDocumentBuffer(
  storagePath: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET)
    .download(storagePath);
  if (error || !data) {
    throw new Error(`Failed to fetch document: ${error?.message ?? "unknown"}`);
  }
  const buffer = Buffer.from(await data.arrayBuffer());
  const contentType = data.type || "image/jpeg";
  return { buffer, contentType };
}

// ─── Route handler ──────────────────────────────────────────────────────────
//
// Decentro OCR is the sole provider. No local OCR (Tesseract) and no regex
// post-processing — Decentro's structured `data.ocrResult.*` output is
// authoritative. If Decentro doesn't return usable fields, we return an
// error so the dealer enters details manually instead of getting garbage
// auto-filled.
//
// Two supported request shapes:
//  1. JSON `{ frontId, backId, leadId? }` — files were pre-uploaded via
//     /api/documents/upload; we fetch from Supabase Storage.
//  2. Multipart form-data with `aadhaarFront` + `aadhaarBack` File parts.

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireRole(["dealer"]);

  const contentType = req.headers.get("content-type") || "";
  const requestId = `OCR-${Date.now()}`;

  let frontBuffer: Buffer;
  let backBuffer: Buffer;
  let frontContentType = "image/jpeg";
  let backContentType = "image/jpeg";
  let frontName = "front.jpg";
  let backName = "back.jpg";
  let leadId: string | undefined;

  if (contentType.includes("application/json")) {
    let payload: {
      idType?: string;
      leadId?: string;
      frontId?: string;
      backId?: string;
    };
    try {
      payload = await req.json();
    } catch {
      return errorResponse("JSON body expected with { frontId, backId }", 400);
    }

    const { frontId, backId } = payload;
    leadId = payload.leadId;
    if (!frontId || !backId) {
      return errorResponse("Both frontId and backId are required", 400);
    }

    const docs = await db
      .select()
      .from(leadDocuments)
      .where(inArray(leadDocuments.id, [frontId, backId]));

    const frontDoc = docs.find((d) => d.id === frontId);
    const backDoc = docs.find((d) => d.id === backId);

    if (!frontDoc || !backDoc) {
      return errorResponse("One or both documents not found", 404);
    }
    if (
      frontDoc.dealer_id !== user.dealer_id ||
      backDoc.dealer_id !== user.dealer_id
    ) {
      return errorResponse("Not authorized for these documents", 403);
    }

    const [front, back] = await Promise.all([
      fetchDocumentBuffer(frontDoc.storage_path),
      fetchDocumentBuffer(backDoc.storage_path),
    ]);

    frontBuffer = front.buffer;
    backBuffer = back.buffer;
    frontContentType = front.contentType;
    backContentType = back.contentType;
    frontName = frontDoc.storage_path.split("/").pop() ?? "front.jpg";
    backName = backDoc.storage_path.split("/").pop() ?? "back.jpg";
  } else if (contentType.includes("multipart/form-data")) {
    const formData = await req.formData();
    const front = formData.get("aadhaarFront");
    const back = formData.get("aadhaarBack");

    if (!(front instanceof File) || !(back instanceof File)) {
      return errorResponse(
        "Both Aadhaar front and back files are required",
        400,
      );
    }

    frontBuffer = Buffer.from(await front.arrayBuffer());
    backBuffer = Buffer.from(await back.arrayBuffer());
    frontContentType = front.type || "image/jpeg";
    backContentType = back.type || "image/jpeg";
    frontName = front.name || "front.jpg";
    backName = back.name || "back.jpg";
  } else {
    return errorResponse(
      "Unsupported Content-Type. Use application/json with { frontId, backId } or multipart/form-data with aadhaarFront + aadhaarBack",
      415,
    );
  }

  try {
    await db.insert(auditLogs).values({
      id: `AUDIT-REQ-${requestId}`,
      entity_type: "system",
      entity_id: requestId,
      action: "OCR_REQUESTED",
      changes: { leadId: leadId ?? null, contentType, provider: "decentro" },
      performed_by: user.id,
      timestamp: new Date(),
    });
  } catch (logErr) {
    console.error("Initial OCR log failed:", logErr);
  }

  // ── Decentro OCR: front + back in parallel ──────────────────────────
  const frontBlob = new Blob([new Uint8Array(frontBuffer)], {
    type: frontContentType,
  });
  const backBlob = new Blob([new Uint8Array(backBuffer)], {
    type: backContentType,
  });

  // Decentro's Aadhaar OCR prioritises different fields depending on
  // document_side (front → name/DOB, back → UID/address).
  const [frontOCR, backOCR] = await Promise.all([
    extractDocumentOcr("AADHAAR", frontBlob, frontName, "FRONT").catch((e) => {
      console.error("[AutoFill] Decentro front OCR threw:", e?.message);
      return null;
    }),
    extractDocumentOcr("AADHAAR", backBlob, backName, "BACK").catch((e) => {
      console.error("[AutoFill] Decentro back OCR threw:", e?.message);
      return null;
    }),
  ]);

  const frontFailed = isDecentroFailure(frontOCR);
  const backFailed = isDecentroFailure(backOCR);

  if (frontFailed && backFailed) {
    console.warn("[AutoFill] Decentro failed on both sides");
    try {
      await db.insert(auditLogs).values({
        id: `AUDIT-FAIL-${requestId}`,
        entity_type: "system",
        entity_id: requestId,
        action: "OCR_FAILED",
        changes: {
          reason: "decentro_unavailable",
          frontMessage: frontOCR?.message ?? null,
          backMessage: backOCR?.message ?? null,
        },
        performed_by: user.id,
        timestamp: new Date(),
      });
    } catch {
      /* ignore */
    }
    return errorResponse(
      "We couldn't read this Aadhaar. Please upload clearer, well-lit photos or enter details manually.",
      422,
    );
  }

  const frontStructured = frontFailed
    ? extractStructuredAadhaar(null)
    : extractStructuredAadhaar(frontOCR);
  const backStructured = backFailed
    ? extractStructuredAadhaar(null)
    : extractStructuredAadhaar(backOCR);

  // No local regex fallback — pass empty `parsed` objects. Decentro's
  // structured fields are the only source of truth.
  const finalData = buildFinalData(frontStructured, backStructured, {}, {});

  if (!hasUsefulData(finalData)) {
    try {
      await db.insert(auditLogs).values({
        id: `AUDIT-FAIL-${requestId}`,
        entity_type: "system",
        entity_id: requestId,
        action: "OCR_FAILED",
        changes: { reason: "decentro_empty_fields" },
        performed_by: user.id,
        timestamp: new Date(),
      });
    } catch {
      /* ignore */
    }
    return errorResponse(
      "Decentro could not extract any fields from the Aadhaar. Please upload clearer photos or enter details manually.",
      422,
    );
  }

  const expectedFields = [
    "full_name",
    "father_or_husband_name",
    "dob",
    "current_address",
  ] as const;
  const missing = expectedFields.filter((k) => !finalData[k]);
  const ocrStatus = missing.length === 0 ? "success" : "partial";

  try {
    await db.insert(auditLogs).values({
      id: `AUDIT-${ocrStatus.toUpperCase()}-${requestId}`,
      entity_type: "system",
      entity_id: requestId,
      action: "OCR_SUCCESS",
      changes: {
        provider: "decentro",
        missing,
        fields_found: Object.entries(finalData)
          .filter(([, v]) => !!v)
          .map(([k]) => k),
      },
      performed_by: user.id,
      timestamp: new Date(),
    });
  } catch (logErr) {
    console.error("Success OCR log failed:", logErr);
  }

  console.log(
    `[AutoFill] Decentro OCR ${ocrStatus} — fields:`,
    Object.entries(finalData)
      .filter(([, v]) => !!v)
      .map(([k]) => k)
      .join(", "),
  );

  return successResponse({
    requestId,
    ocrStatus,
    missingFields: missing.length > 0 ? missing : undefined,
    source: "decentro",
    auto_filled: true,
    ...finalData,
  });
});

export async function OPTIONS() {
  return NextResponse.json({ ok: true });
}
