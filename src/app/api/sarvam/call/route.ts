// Single Sarvam call, placed by a person pressing "Call" (CallButton, the
// /leads dialer loop). Same contract as /api/elevenlabs/call.

import { NextRequest, NextResponse } from "next/server";
import { triggerSarvamCall } from "@/lib/ai/sarvam/triggerCall";
import { requireRole } from "@/lib/auth-utils";
import {
  attachBolnaCallId,
  markCampaignLeadCalling,
} from "@/lib/queue/campaignTracker";
import { fetchAiConnection } from "@/lib/ai-dialer/aiConnection";

// Billed per minute — sales staff and admins only, same set as the other
// provider call routes.
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
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Forbidden" },
      { status: 403 },
    );
  }

  try {
    const body = await req.json();
    if (!body?.phone) {
      return NextResponse.json(
        { success: false, error: "phone is required" },
        { status: 400 },
      );
    }

    // The AI-connected hard block — identical to the other provider routes.
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

    const result = await triggerSarvamCall({
      phone: body.phone,
      leadId: body.leadId,
      scheduledAt: body.scheduledAt,
      // A human pressed "Call": a same-day re-dial is the intent.
      bypassIdempotency: body.bypassIdempotency ?? true,
    });

    if (body.leadId) {
      await markCampaignLeadCalling({ leadId: body.leadId });
      // attempt_id goes in bolna_call_id (shared by all providers) — the
      // webhook handler finds the campaign row by it.
      if (result.success && result.call_id) {
        await attachBolnaCallId({ leadId: body.leadId, callId: result.call_id });
      }
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("[SARVAM CALL] Error:", err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
