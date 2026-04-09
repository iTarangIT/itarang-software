import { handleBolnaWebhook } from "@/lib/ai/bolna_ai";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    console.log("WEBHOOK HIT", JSON.stringify({
      status: body.status,
      hasTranscript: !!body.transcript,
      phone: body.user_number || body.recipient_phone_number,
      keys: Object.keys(body),
    }));

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
