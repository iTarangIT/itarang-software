import { NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { triggerElevenLabsCall } from "@/lib/ai/elevenlabs/triggerCall";
import { aiConnectedSet } from "@/lib/ai-dialer/aiConnection";

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

  // The AI-connected hard block — see the note in the Bolna twin. A QStash
  // message enqueued before the lead connected can arrive after it did.
  if (payload.leadId) {
    const connected = await aiConnectedSet([payload.leadId]);
    if (connected.size > 0) {
      console.warn(
        `[elevenlabs/dispatch-call] dropping AI follow-up for ${payload.leadId}: already connected`,
      );
      return NextResponse.json({
        success: false,
        code: "ai_already_connected",
        error: "The AI has already spoken with this dealer.",
      });
    }
  }

  const result = await triggerElevenLabsCall({
    phone: payload.phone,
    leadId: payload.leadId ?? "",
  });

  return NextResponse.json(result);
}
