import { NextRequest, NextResponse } from "next/server";
import { triggerElevenLabsCall } from "@/lib/ai/elevenlabs/triggerCall";
import { requireRole } from "@/lib/auth-utils";
import {
  attachBolnaCallId,
  markCampaignLeadCalling,
} from "@/lib/queue/campaignTracker";
import { fetchAiConnection } from "@/lib/ai-dialer/aiConnection";

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

    // The AI-connected hard block — identical to /api/bolna/call, same reasoning.
    if (body.leadId) {
      const connection = await fetchAiConnection(String(body.leadId));
      if (connection.connected) {
        return NextResponse.json(
          {
            success: false,
            code: "ai_already_connected",
            error: "The AI has already spoken with this dealer.",
            connection,
          },
          { status: 409 },
        );
      }
    }

    const result = await triggerElevenLabsCall({
      phone: body.phone,
      leadId: body.leadId,
      scheduledAt: body.scheduledAt,
      // This route is only ever hit by a human pressing "Call" (the per-lead
      // call buttons). That's a deliberate action — re-dialing a lead the same
      // day (e.g. retrying a failed call) is exactly the intent — so bypass the
      // once-per-day idempotency guard by default. The guard still protects the
      // automated QStash dispatch path (/api/elevenlabs/dispatch-call). A caller
      // can pass bypassIdempotency:false to opt back into the guard.
      bypassIdempotency: body.bypassIdempotency ?? true,
    });

    console.log("[ELEVENLABS CALL] Result:", result);

    // Flip the active campaign-lead row to 'calling'. Best-effort: no-op
    // when there's no active campaign (e.g. a one-off cron-triggered call).
    if (body.leadId) {
      await markCampaignLeadCalling({ leadId: body.leadId });
      // Persist the ElevenLabs conversation_id on the campaign-lead row
      // (column is bolna_call_id but doubles for both providers) so
      // /api/cron/dialer-poll can recover this call if the webhook drops.
      const callId = (result as { call_id?: string })?.call_id;
      if (result?.success && callId) {
        await attachBolnaCallId({ leadId: body.leadId, callId });
      }
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
