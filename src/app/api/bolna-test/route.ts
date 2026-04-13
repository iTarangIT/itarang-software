import { NextRequest, NextResponse } from "next/server";
import { triggerBolnaCall } from "@/lib/ai/bolna_ai/triggerCall";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    console.log("[BOLNA CALL] Incoming request body:", body);

    // ✅ Validate phone number
    if (!body.phone) {
      return NextResponse.json(
        { success: false, error: "phone is required" },
        { status: 400 },
      );
    }

    // ✅ Trigger call using triggerBolnaCall (fetches lead from DB automatically)
    const result = await triggerBolnaCall({
      phone: body.phone,
      leadId: body.leadId,
      scheduledAt: body.scheduledAt,
    });

    console.log("[BOLNA CALL] Result:", result);

    // ✅ Return result
    return NextResponse.json(result);

  } catch (err: any) {
    console.error("[BOLNA CALL] Error:", err);
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 },
    );
  }
}