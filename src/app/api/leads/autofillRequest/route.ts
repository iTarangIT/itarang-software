export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auditLogs, leadDocuments } from "@/lib/db/schema";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { extractDocumentOcr } from "@/lib/decentro";
import { extractTextFromImageBuffer } from "@/lib/ocr/tesseractOcr";
import { parseAadhaarText } from "@/lib/ocr/parseAadhaarText";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { inArray } from "drizzle-orm";

// ─── Helpers (shared with main-branch parsing quality) ──────────────────────

const BUCKET = "private-documents";

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDate(value: string): string {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const m = value.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  return value.trim();
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const v = clean(value);
    if (v) return v;
  }
  return "";
}

function getDeep(obj: any, paths: string[]): string {
  for (const path of paths) {
    const value = path.split(".").reduce((acc: any, key) => acc?.[key], obj);
    const cleaned = clean(value);
    if (cleaned) return cleaned;
  }
  return "";
}

// Extract Aadhaar fields from a Decentro response that can be shaped in
// many ways (older and newer API versions nest differently).
function extractStructuredAadhaar(payload: any) {
  return {
    fullName: firstNonEmpty(
      getDeep(payload, [
        "ocrResult.name",
        "data.full_name",
        "data.name",
        "data.customer_name",
        "data.nameOnCard",
        "response.full_name",
        "response.name",
        "result.full_name",
        "result.name",
      ]),
    ),
    fatherName: firstNonEmpty(
      getDeep(payload, [
        "ocrResult.fatherName",
        "ocrResult.sonOf",
        "ocrResult.husbandOf",
        "data.father_name",
        "data.fatherName",
        "data.father_or_husband_name",
        "data.fatherOrHusbandName",
        "response.father_name",
        "result.father_name",
      ]),
    ),
    dob: normalizeDate(
      firstNonEmpty(
        getDeep(payload, [
          "ocrResult.dateInfo",
          "data.dob",
          "data.date_of_birth",
          "data.dateOfBirth",
          "response.dob",
          "result.dob",
        ]),
      ),
    ),
    phone: firstNonEmpty(
      getDeep(payload, [
        "data.phone",
        "data.mobile",
        "data.mobile_number",
        "response.phone",
        "result.phone",
      ]),
    ),
    address: firstNonEmpty(
      getDeep(payload, [
        "ocrResult.address",
        "data.address",
        "data.full_address",
        "data.current_address",
        "data.currentAddress",
        "response.address",
        "result.address",
      ]),
    ),
    aadhaarNumber: firstNonEmpty(
      getDeep(payload, [
        "ocrResult.aadhaarNumber",
        "data.aadhaar_number",
        "data.aadhaarNumber",
        "data.uid",
        "response.aadhaar_number",
        "result.aadhaar_number",
      ]),
    ),
    rawText: firstNonEmpty(
      getDeep(payload, [
        "data.ocr_text",
        "data.raw_text",
        "data.text",
        "response.ocr_text",
        "response.raw_text",
        "response.text",
        "ocr_text",
        "raw_text",
        "text",
      ]),
    ),
  };
}

// If the structured OCR didn't give us a father name, some Aadhaars print
// it inline in the address as "S/O: <name>, ...". Pick that out.
function extractFatherFromAddress(address: string): string {
  if (!address) return "";
  const pattern = /[SDWC]\/[Oo]:?\s+([^,]+)/g;
  const matches: string[] = [];
  let m;
  while ((m = pattern.exec(address)) !== null) {
    const name = m[1].trim();
    const latinChars = name.replace(/[^A-Za-z]/g, "").length;
    const totalChars = name.replace(/[\s]/g, "").length;
    if (totalChars > 0 && latinChars / totalChars > 0.7) {
      const cleanedName = name.replace(/[^A-Za-z\s]/g, "").trim();
      // Each word must be 3+ chars to filter OCR garbage
      const words = cleanedName.split(" ").filter((w) => w.length >= 3);
      if (words.length >= 1) {
        matches.push(
          words
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(" "),
        );
      }
    }
  }
  return matches.length > 0 ? matches[matches.length - 1] : "";
}

// Strip OCR garbage from address strings (UIDAI watermarks, URLs, the
// Aadhaar number when it leaks in, stray pipes/punctuation).
function cleanAddress(address: string): string {
  if (!address) return "";
  let cleaned = address.replace(/[SDWC]\/[Oo]:?\s+[^,]+,\s*/g, "");
  cleaned = cleaned
    .replace(/\b[|]\s*/g, "")
    .replace(/[™®©]/g, "")
    .replace(/\bwww\.[^\s,]+/gi, "")
    .replace(/help@[^\s,]+/gi, "")
    .replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, "")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*$/g, "")
    .replace(/^\s*,\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned;
}

function hasUsefulData(data: Record<string, string>) {
  return Object.values(data).some((v) => clean(v) !== "");
}

// Decentro can "succeed" at the HTTP layer but return an error payload
// (IP not whitelisted, credits exhausted, etc). Detect those.
function isDecentroFailure(response: any): boolean {
  if (!response) return true;
  if (response.status === "FAILURE" || response.ocrStatus === "FAILURE") return true;
  if (response.error?.responseCode) return true;
  // IP not whitelisted / auth errors — message present but no OCR payload.
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

// Merge all OCR sources (Decentro structured, Aadhaar-text-regex of raw
// OCR text) and preserve the strongest value per field. Prefer front of
// card for identity, back for address.
function buildFinalData(
  frontStructured: ReturnType<typeof extractStructuredAadhaar>,
  backStructured: ReturnType<typeof extractStructuredAadhaar>,
  frontParsed: any,
  backParsed: any,
) {
  const rawAddress = firstNonEmpty(
    backStructured.address,
    frontStructured.address,
    backParsed?.address,
    frontParsed?.address,
  );
  const fatherFromAddress = extractFatherFromAddress(rawAddress);
  const cleanedAddress = rawAddress ? cleanAddress(rawAddress) : "";

  const fullName = firstNonEmpty(
    frontStructured.fullName,
    backStructured.fullName,
    frontParsed?.fullName,
    backParsed?.fullName,
  );
  const fatherName = firstNonEmpty(
    frontStructured.fatherName,
    backStructured.fatherName,
    frontParsed?.fatherName,
    backParsed?.fatherName,
    fatherFromAddress,
  );
  const phone = firstNonEmpty(
    frontStructured.phone,
    backStructured.phone,
    frontParsed?.phone,
    backParsed?.phone,
  );
  const dob = normalizeDate(
    firstNonEmpty(
      frontStructured.dob,
      backStructured.dob,
      frontParsed?.dob,
      backParsed?.dob,
    ),
  );
  const aadhaarNumber = firstNonEmpty(
    frontStructured.aadhaarNumber,
    backStructured.aadhaarNumber,
  );
  const address = cleanedAddress || rawAddress;

  return {
    // snake_case aliases the lead form consumes directly
    full_name: fullName,
    father_or_husband_name: fatherName,
    current_address: address,
    permanent_address: address,
    phone,
    dob,
    aadhaar_number: aadhaarNumber,
    // camelCase aliases that other call sites use
    fullName,
    fatherName,
    address,
    aadhaarNumber,
  };
}

// ─── Route handler ──────────────────────────────────────────────────────────
//
// Two supported request shapes:
//  1. JSON `{ frontId, backId, leadId? }` — files were pre-uploaded via
//     /api/documents/upload. We verify dealer ownership of those rows and
//     fetch the files from Supabase Storage. This is what the current
//     dealer lead-creation UI sends.
//  2. Multipart form-data with `aadhaarFront` + `aadhaarBack` File parts —
//     direct upload. Kept for compatibility with older call sites / scripts.
//
// Both converge on the same Decentro-primary, Tesseract-fallback OCR
// pipeline and return the same response shape.

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
    // Shape 1: documentIds already in DB
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
    // Shape 2: direct multipart upload
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

  // Audit: request logged
  try {
    await db.insert(auditLogs).values({
      id: `AUDIT-REQ-${requestId}`,
      entity_type: "system",
      entity_id: requestId,
      action: "OCR_REQUESTED",
      changes: { leadId: leadId ?? null, contentType },
      performed_by: user.id,
      timestamp: new Date(),
    });
  } catch (logErr) {
    console.error("Initial OCR log failed:", logErr);
  }

  // ── OCR pipeline ────────────────────────────────────────────────────
  let frontStructured = extractStructuredAadhaar(null);
  let backStructured = extractStructuredAadhaar(null);
  let frontParsed: any = {};
  let backParsed: any = {};
  let source: "decentro" | "tesseract" = "decentro";
  let usedFallback = false;

  // Primary: Decentro OCR on both sides
  try {
    const frontBlob = new Blob([new Uint8Array(frontBuffer)], {
      type: frontContentType,
    });
    const backBlob = new Blob([new Uint8Array(backBuffer)], {
      type: backContentType,
    });

    const [frontOCR, backOCR] = await Promise.all([
      extractDocumentOcr("AADHAAR", frontBlob, frontName).catch((e) => {
        console.error("[AutoFill] Decentro front OCR threw:", e?.message);
        return null;
      }),
      extractDocumentOcr("AADHAAR", backBlob, backName).catch((e) => {
        console.error("[AutoFill] Decentro back OCR threw:", e?.message);
        return null;
      }),
    ]);

    if (isDecentroFailure(frontOCR) && isDecentroFailure(backOCR)) {
      console.warn(
        "[AutoFill] Decentro failed on both sides, falling back to Tesseract",
      );
      throw new Error("decentro_failed");
    }

    if (!isDecentroFailure(frontOCR)) {
      frontStructured = extractStructuredAadhaar(frontOCR);
      if (frontStructured.rawText) {
        frontParsed = parseAadhaarText(frontStructured.rawText);
      }
    }
    if (!isDecentroFailure(backOCR)) {
      backStructured = extractStructuredAadhaar(backOCR);
      if (backStructured.rawText) {
        backParsed = parseAadhaarText(backStructured.rawText);
      }
    }
  } catch {
    // Fallback: local Tesseract OCR
    console.log("[AutoFill] Using Tesseract.js fallback OCR");
    source = "tesseract";
    usedFallback = true;

    try {
      const [frontText, backText] = await Promise.all([
        extractTextFromImageBuffer(frontBuffer),
        extractTextFromImageBuffer(backBuffer),
      ]);

      frontParsed = frontText ? parseAadhaarText(frontText) : {};
      backParsed = backText ? parseAadhaarText(backText) : {};
    } catch (tesseractErr: any) {
      console.error("[AutoFill] Tesseract fallback failed:", tesseractErr?.message);
    }
  }

  const finalData = buildFinalData(
    frontStructured,
    backStructured,
    frontParsed,
    backParsed,
  );

  if (!hasUsefulData(finalData)) {
    try {
      await db.insert(auditLogs).values({
        id: `AUDIT-FAIL-${requestId}`,
        entity_type: "system",
        entity_id: requestId,
        action: "OCR_FAILED",
        changes: { reason: "No useful fields extracted", source, usedFallback },
        performed_by: user.id,
        timestamp: new Date(),
      });
    } catch {
      /* ignore */
    }

    return successResponse({
      requestId,
      ocrStatus: "failed",
      ocrError: usedFallback
        ? "Decentro credits/access unavailable and fallback OCR could not extract fields — please ensure the Aadhaar images are clear and well-lit."
        : "OCR response came back, but no usable Aadhaar fields were extracted. Please retake clearer photos.",
      auto_filled: false,
      fallback: usedFallback,
      source,
    });
  }

  // Determine partial vs full success
  const expectedFields = [
    "full_name",
    "father_or_husband_name",
    "dob",
    "current_address",
  ] as const;
  const missing = expectedFields.filter(
    (k) => !(finalData as Record<string, string>)[k],
  );
  const ocrStatus = missing.length === 0 ? "success" : "partial";

  try {
    await db.insert(auditLogs).values({
      id: `AUDIT-${ocrStatus.toUpperCase()}-${requestId}`,
      entity_type: "system",
      entity_id: requestId,
      action: "OCR_SUCCESS",
      changes: {
        source,
        usedFallback,
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

  return successResponse({
    requestId,
    ocrStatus,
    missingFields: missing.length > 0 ? missing : undefined,
    source,
    fallback: usedFallback,
    auto_filled: true,
    ...finalData,
  });
});

// Support older clients that used PUT or GET-with-body during migration.
// Same handler, same contract.
export async function OPTIONS() {
  return NextResponse.json({ ok: true });
}
