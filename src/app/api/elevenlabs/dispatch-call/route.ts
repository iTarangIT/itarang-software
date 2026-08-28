import { NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { triggerElevenLabsCall } from "@/lib/ai/elevenlabs/triggerCall";
import {
  attachBolnaCallId,
  markCampaignLeadCalling,
} from "@/lib/queue/campaignTracker";

export const maxDuration = 60;

let receiver: Receiver | null = null;

function getReceiver(): Receiver {
  if (!receiver) {
    const current = process.env.QSTASH_CURRENT_SIGNING_KEY;
    const next = process.env.QSTASH_NEXT_SIGNING_KEY;
    if (!current || !next) {
      throw new Error(
        "QSTASH_CURRENT_SIGNING_KEY and QSTASH_NEXT_SIGNING_KEY are required",
      );
    }
    receiver = new Receiver({
      currentSigningKey: current,
      nextSigningKey: next,
    });
  }
  return receiver;
}

export async function POST(req: Request) {
  const signature = req.headers.get("upstash-signature");
  const rawBody = await req.text();

  if (!signature) {
    return NextResponse.json(
      { success: false, error: "Missing signature" },
      { status: 401 },
    );
  }

  try {
    const valid = await getReceiver().verify({
      signature,
      body: rawBody,
    });
    if (!valid) {
      return NextResponse.json(
        { success: false, error: "Invalid signature" },
        { status: 401 },
      );
    }
  } catch (err) {
    console.error("[elevenlabs:dispatch-call] signature verify failed", err);
    return NextResponse.json(
      { success: false, error: "Signature verification error" },
      { status: 401 },
    );
  }

  let payload: { phone?: string; leadId?: string };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 },
    );
  }

  if (!payload.phone) {
    return NextResponse.json(
      { success: false, error: "phone required" },
      { status: 400 },
    );
  }

  const result = await triggerElevenLabsCall({
    phone: payload.phone,
    leadId: payload.leadId ?? "",
  });

  // Persist the conversation_id on the campaign-lead row, exactly as
  // /api/elevenlabs/call and advanceCampaign already do. Without it,
  // runDialerPollOnce — which selects on `bolna_call_id IS NOT NULL` — cannot
  // see a QStash-scheduled call, so the poll backstop that exists to recover a
  // dropped webhook silently skips every call dispatched through this route.
  // Best-effort: a one-off call with no active campaign row is a no-op.
  if (payload.leadId) {
    const callId = (result as { call_id?: string })?.call_id;
    if (result?.success && callId) {
      try {
        await markCampaignLeadCalling({ leadId: payload.leadId });
        await attachBolnaCallId({ leadId: payload.leadId, callId });
      } catch (err) {
        console.error("[elevenlabs:dispatch-call] attach failed:", err);
      }
    }
  }

  return NextResponse.json(result);
}
