import { NextRequest, NextResponse } from "next/server";
import { triggerElevenLabsCall } from "@/lib/ai/elevenlabs/triggerCall";
import { requireRole } from "@/lib/auth-utils";
import { markCampaignLeadCalling } from "@/lib/queue/campaignTracker";

// ElevenLabs calls are billed per-minute. Without auth, any anonymous POST
// could burn provider credit and harass leads. Restrict to sales staff and
// admins; same set as /api/bolna/call.
const CALL_ROLES = [
  "ceo",
  "business_head",
  "sales_head",
  "sales_manager",
  "sales_executive",
  "admin",
];

export async function POST(req: NextRequest) {
  try {
    await requireRole(CALL_ROLES);
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message ?? "Forbidden" },
      { status: 403 },
    );
  }

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

    // Flip the active campaign-lead row to 'calling'. Best-effort: no-op
    // when there's no active campaign (e.g. a one-off cron-triggered call).
    if (body.leadId) {
      await markCampaignLeadCalling({ leadId: body.leadId });
    }

    return NextResponse.json(result);
  } catch (err: any) {
    console.error("[ELEVENLABS CALL] Error:", err);
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 },
    );
  }
}
