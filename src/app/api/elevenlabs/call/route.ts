import { NextRequest, NextResponse } from "next/server";
import { triggerElevenLabsCall } from "@/lib/ai/elevenlabs/triggerCall";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    console.log("[ELEVENLABS CALL] Incoming request body:", body);

    if (!body.phone) {
      return NextResponse.json(
        { success: false, error: "phone is required" },
        { status: 400 },
      );
    }

    const result = await triggerElevenLabsCall({
      phone: body.phone,
      leadId: body.leadId,
      scheduledAt: body.scheduledAt,
    });

    console.log("[ELEVENLABS CALL] Result:", result);

    return NextResponse.json(result);
  } catch (err: any) {
    console.error("[ELEVENLABS CALL] Error:", err);
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 },
    );
  }
}
