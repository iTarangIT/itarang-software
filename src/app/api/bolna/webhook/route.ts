import { handleBolnaWebhook } from "@/lib/ai/bolna_ai";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    console.log("WEBHOOK HIT");

    const body = await req.json();

    await handleBolnaWebhook(body);

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("API error:", err);

    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 },
    );
  }
}
