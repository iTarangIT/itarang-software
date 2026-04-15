import { NextRequest, NextResponse } from "next/server";
import { extractDocumentOcr } from "@/lib/decentro";
import { parseAadhaarText } from "@/lib/ocr/parseAadhaarText";
import { extractTextFromImageBuffer } from "@/lib/ocr/tesseractOcr";

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDate(value: string): string {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const m = value.match(/^(\d{2})[\/.-](\d{2})[\/.-](\d{4})$/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    return `${yyyy}-${mm}-${dd}`;
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
      ])
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
      ])
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
        ])
      )
    ),
    phone: firstNonEmpty(
      getDeep(payload, [
        "data.phone",
        "data.mobile",
        "data.mobile_number",
        "response.phone",
        "result.phone",
      ])
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
      ])
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
      ])
    ),
  };
}

function extractFatherFromAddress(address: string): string {
  const pattern = /[SDWC]\/[Oo]:?\s+([^,]+)/g;
  const matches: string[] = [];
  let m;
  while ((m = pattern.exec(address)) !== null) {
    const name = m[1].trim();
    const latinChars = name.replace(/[^A-Za-z]/g, "").length;
    const totalChars = name.replace(/[\s]/g, "").length;
    if (totalChars > 0 && latinChars / totalChars > 0.7) {
      const cleaned = name.replace(/[^A-Za-z\s]/g, "").trim();
      // Each word must be 3+ chars to filter garbage
      const words = cleaned.split(" ").filter((w: string) => w.length >= 3);
      if (words.length >= 1) {
        matches.push(words.map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" "));
      }
    }
  }
  return matches.length > 0 ? matches[matches.length - 1] : "";
}

function cleanAddress(address: string): string {
  // Remove S/O, D/O, W/O, C/O prefixes with names (handles both S/O and S/O: formats)
  let cleaned = address.replace(/[SDWC]\/[Oo]:?\s+[^,]+,\s*/g, "");

  // Remove common OCR garbage
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

function isDecentroFailure(response: any): boolean {
  if (!response) return true;
  if (response.status === "FAILURE" || response.ocrStatus === "FAILURE") return true;
  if (response.error?.responseCode) return true;
  // IP not whitelisted or other auth errors (no ocrResult means no useful data)
  if (response.message && !response.ocrResult && !response.data) return true;
  return false;
}

function buildFinalData(
  frontStructured: ReturnType<typeof extractStructuredAadhaar>,
  backStructured: ReturnType<typeof extractStructuredAadhaar>,
  frontParsed: any,
  backParsed: any
) {
  const rawAddress = firstNonEmpty(
    backStructured.address,
    frontStructured.address,
    backParsed?.address,
    frontParsed?.address
  );
  const fatherFromAddress = extractFatherFromAddress(rawAddress);
  const cleanedAddress = rawAddress ? cleanAddress(rawAddress) : "";

  return {
    full_name: firstNonEmpty(
      frontStructured.fullName,
      backStructured.fullName,
      frontParsed?.fullName,
      backParsed?.fullName
    ),
    father_or_husband_name: firstNonEmpty(
      frontStructured.fatherName,
      backStructured.fatherName,
      frontParsed?.fatherName,
      backParsed?.fatherName,
      fatherFromAddress
    ),
    phone: firstNonEmpty(
      frontStructured.phone,
      backStructured.phone,
      frontParsed?.phone,
      backParsed?.phone
    ),
    dob: normalizeDate(
      firstNonEmpty(
        frontStructured.dob,
        backStructured.dob,
        frontParsed?.dob,
        backParsed?.dob
      )
    ),
    current_address: cleanedAddress || rawAddress,
    permanent_address: cleanedAddress || rawAddress,
  };
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const front = formData.get("aadhaarFront");
    const back = formData.get("aadhaarBack");

    if (!(front instanceof File) || !(back instanceof File)) {
      return NextResponse.json(
        {
          success: false,
          error: { message: "Both Aadhaar front and back files are required" },
        },
        { status: 400 }
      );
    }

    const frontBuffer = Buffer.from(await front.arrayBuffer());
    const backBuffer = Buffer.from(await back.arrayBuffer());

    let frontStructured = { fullName: "", fatherName: "", dob: "", phone: "", address: "", rawText: "" };
    let backStructured = { fullName: "", fatherName: "", dob: "", phone: "", address: "", rawText: "" };
    let frontParsed: any = {};
    let backParsed: any = {};
    let usedFallback = false;

    // ── Try Decentro first ──────────────────────────────────────────────
    try {
      const frontBlob = new Blob([frontBuffer], { type: front.type || "application/octet-stream" });
      const backBlob = new Blob([backBuffer], { type: back.type || "application/octet-stream" });

      const [frontOCR, backOCR] = await Promise.all([
        extractDocumentOcr("AADHAAR", frontBlob, front.name),
        extractDocumentOcr("AADHAAR", backBlob, back.name),
      ]);

      console.log("frontOCR raw =>", JSON.stringify(frontOCR, null, 2));
      console.log("backOCR raw =>", JSON.stringify(backOCR, null, 2));

      if (isDecentroFailure(frontOCR) || isDecentroFailure(backOCR)) {
        console.warn("[AutoFill] Decentro failed, falling back to Tesseract OCR...");
        throw new Error("decentro_failed");
      }

      frontStructured = extractStructuredAadhaar(frontOCR);
      backStructured = extractStructuredAadhaar(backOCR);

      frontParsed = frontStructured.rawText ? parseAadhaarText(frontStructured.rawText) : {};
      backParsed = backStructured.rawText ? parseAadhaarText(backStructured.rawText) : {};
    } catch (decentroErr) {
      // ── Fallback: Tesseract.js local OCR ────────────────────────────
      console.log("[AutoFill] Using Tesseract.js fallback OCR...");
      usedFallback = true;

      try {
        const [frontText, backText] = await Promise.all([
          extractTextFromImageBuffer(frontBuffer),
          extractTextFromImageBuffer(backBuffer),
        ]);

        console.log("Tesseract frontText =>", frontText);
        console.log("Tesseract backText =>", backText);

        frontParsed = frontText ? parseAadhaarText(frontText) : {};
        backParsed = backText ? parseAadhaarText(backText) : {};
      } catch (tesseractErr) {
        console.error("[AutoFill] Tesseract fallback also failed:", tesseractErr);
      }
    }

    const finalData = buildFinalData(frontStructured, backStructured, frontParsed, backParsed);

    console.log("frontStructured =>", frontStructured);
    console.log("backStructured =>", backStructured);
    console.log("frontParsed =>", frontParsed);
    console.log("backParsed =>", backParsed);
    console.log("finalData =>", finalData);
    console.log("usedFallback =>", usedFallback);

    if (!hasUsefulData(finalData)) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message: usedFallback
              ? "Decentro credits exhausted. Fallback OCR could not extract fields — please ensure the Aadhaar images are clear and well-lit."
              : "OCR response came back, but no usable Aadhaar fields were extracted.",
          },
        },
        { status: 422 }
      );
    }

    return NextResponse.json({
      success: true,
      data: finalData,
      fallback: usedFallback,
    });
  } catch (error: any) {
    console.error("autofillRequest POST error =>", error);

    return NextResponse.json(
      {
        success: false,
        error: {
          message: error?.message || "OCR failed",
        },
      },
      { status: 500 }
    );
  }
}