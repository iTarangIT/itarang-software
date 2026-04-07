import { NextRequest, NextResponse } from "next/server";
import { extractDocumentOcr } from "@/lib/decentro";
import { parseAadhaarText } from "@/lib/ocr/parseAadhaarText";

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

function hasUsefulData(data: Record<string, string>) {
  return Object.values(data).some((v) => clean(v) !== "");
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

    const frontBlob = new Blob([await front.arrayBuffer()], {
      type: front.type || "application/octet-stream",
    });
    const backBlob = new Blob([await back.arrayBuffer()], {
      type: back.type || "application/octet-stream",
    });

    const [frontOCR, backOCR] = await Promise.all([
      extractDocumentOcr("AADHAAR", frontBlob, front.name),
      extractDocumentOcr("AADHAAR", backBlob, back.name),
    ]);

    console.log("frontOCR raw =>", JSON.stringify(frontOCR, null, 2));
    console.log("backOCR raw =>", JSON.stringify(backOCR, null, 2));

    const frontStructured = extractStructuredAadhaar(frontOCR);
    const backStructured = extractStructuredAadhaar(backOCR);

    const frontParsed = frontStructured.rawText
      ? parseAadhaarText(frontStructured.rawText)
      : {};
    const backParsed = backStructured.rawText
      ? parseAadhaarText(backStructured.rawText)
      : {};

    const finalData = {
      full_name: firstNonEmpty(
        frontStructured.fullName,
        backStructured.fullName,
        (frontParsed as any).fullName,
        (backParsed as any).fullName
      ),
      father_or_husband_name: firstNonEmpty(
        frontStructured.fatherName,
        backStructured.fatherName,
        (frontParsed as any).fatherName,
        (backParsed as any).fatherName
      ),
      phone: firstNonEmpty(
        frontStructured.phone,
        backStructured.phone,
        (frontParsed as any).phone,
        (backParsed as any).phone
      ),
      dob: normalizeDate(
        firstNonEmpty(
          frontStructured.dob,
          backStructured.dob,
          (frontParsed as any).dob,
          (backParsed as any).dob
        )
      ),
      current_address: firstNonEmpty(
        backStructured.address,
        frontStructured.address,
        (backParsed as any).address,
        (frontParsed as any).address
      ),
      permanent_address: firstNonEmpty(
        backStructured.address,
        frontStructured.address,
        (backParsed as any).address,
        (frontParsed as any).address
      ),
    };

    console.log("frontStructured =>", frontStructured);
    console.log("backStructured =>", backStructured);
    console.log("frontParsed =>", frontParsed);
    console.log("backParsed =>", backParsed);
    console.log("finalData =>", finalData);

    if (!hasUsefulData(finalData)) {
      return NextResponse.json(
        {
          success: false,
          error: {
            message:
              "OCR response came back, but no usable Aadhaar fields were extracted.",
          },
          debug: {
            frontStructured,
            backStructured,
            frontParsed,
            backParsed,
            frontOCR,
            backOCR,
          },
        },
        { status: 422 }
      );
    }

    return NextResponse.json({
      success: true,
      data: finalData,
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