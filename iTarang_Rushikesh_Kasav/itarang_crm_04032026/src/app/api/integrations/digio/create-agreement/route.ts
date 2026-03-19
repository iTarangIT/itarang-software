import { NextRequest, NextResponse } from "next/server";
import { createDigioAgreement } from "@/lib/digio/service";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const result = await createDigioAgreement(body);

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    console.error("DIGIO ERROR:", error?.response?.data || error.message);

    return NextResponse.json(
      {
        success: false,
        error: "Failed to create agreement",
      },
      { status: 500 }
    );
  }
}