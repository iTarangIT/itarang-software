import { NextRequest, NextResponse } from "next/server";
import { triggerBolnaCall } from "@/lib/ai/bolna_ai/triggerCall";
import { requireRole } from "@/lib/auth-utils";
import {
  attachBolnaCallId,
  markCampaignLeadCalling,
} from "@/lib/queue/campaignTracker";
import { fetchAiConnection } from "@/lib/ai-dialer/aiConnection";

// Bolna calls are billed per-minute. Without auth, any anonymous POST could
// burn provider credit and harass leads. Restrict to sales staff and admins.
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

    console.log("[BOLNA CALL] Incoming request body:", body);

    if (!body.phone) {
      return NextResponse.json(
        { success: false, error: "phone is required" },
        { status: 400 },
      );
    }

    // The AI-connected hard block.
    //
    // This button fires the AI AGENT at the dealer, so it is the same harm the
    // block exists to prevent — "follow up manually" means the human dials from
    // their own phone, not that they press this. There is deliberately no
    // override. The payload lets the UI render the "already contacted" notice
    // inline, with the call summary and a transcript link, instead of a bare
    // error toast.
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

    const result = await triggerBolnaCall({
      phone: body.phone,
      leadId: body.leadId,
      scheduledAt: body.scheduledAt,
      // This route is only ever hit by a human pressing "Call" (the per-lead
      // call buttons). That's a deliberate action — re-dialing a lead the same
      // day (e.g. retrying a failed call) is exactly the intent — so bypass the
      // once-per-day idempotency guard by default. The guard still protects the
      // automated QStash dispatch path (/api/bolna/dispatch-call). A caller can
      // pass bypassIdempotency:false to opt back into the guard.
      bypassIdempotency: body.bypassIdempotency ?? true,
    });

    console.log("[BOLNA CALL] Result:", result);

    // Flip the active campaign-lead row to 'calling'. Best-effort: no-op
    // when there's no active campaign (e.g. a one-off cron-triggered call).
    if (body.leadId) {
      await markCampaignLeadCalling({ leadId: body.leadId });
      // Persist the Bolna execution_id on the campaign-lead row right away
      // so /api/cron/dialer-poll can recover this call if the webhook drops.
      const callId = (result as { call_id?: string })?.call_id;
      if (result?.success && callId) {
        await attachBolnaCallId({ leadId: body.leadId, callId });
      }
    }

    return NextResponse.json(result);
  } catch (err: any) {
    console.error("[BOLNA CALL] Error:", err);
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 },
    );
  }
}
