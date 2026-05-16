import { handleElevenLabsWebhook } from "@/lib/ai/elevenlabs";
import {
  verifyWebhookEvent,
  WebhookSecretMissingError,
} from "@/lib/ai/elevenlabs/signature";
import { after, NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  // Critical: read raw body BEFORE any JSON parsing — HMAC verification
  // requires the exact bytes ElevenLabs signed.
  const rawBody = await req.text();
  const signature = req.headers.get("elevenlabs-signature");

  if (!signature) {
    console.warn("[ELEVENLABS WEBHOOK] Missing elevenlabs-signature header");
    return NextResponse.json(
      { success: false, error: "Missing signature" },
      { status: 401 },
    );
  }

  let event;
  try {
    event = await verifyWebhookEvent(rawBody, signature);
  } catch (err) {
    if (err instanceof WebhookSecretMissingError) {
      // Dev-friendly: accept unverified payloads on localhost so operators
      // can test the call lifecycle through ngrok without configuring a
      // shared secret. Production still hard-rejects.
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          "[ELEVENLABS WEBHOOK] ELEVENLABS_WEBHOOK_SECRET missing — accepting in dev. " +
            "Set the env var before deploying.",
        );
        try {
          event = JSON.parse(rawBody);
        } catch (parseErr) {
          console.error(
            "[ELEVENLABS WEBHOOK] body parse failed in dev-accept path:",
            parseErr,
          );
          return NextResponse.json(
            { success: false, error: "Bad payload" },
            { status: 400 },
          );
        }
      } else {
        console.error(
          "[ELEVENLABS WEBHOOK] ELEVENLABS_WEBHOOK_SECRET is not configured in production — webhook rejected.",
        );
        return NextResponse.json(
          { success: false, error: "Webhook not configured" },
          { status: 401 },
        );
      }
    } else {
      console.warn("[ELEVENLABS WEBHOOK] Signature verification failed", err);
      return NextResponse.json(
        { success: false, error: "Invalid signature" },
        { status: 401 },
      );
    }
  }

  console.log("[ELEVENLABS WEBHOOK] HIT", {
    type: (event as any)?.type,
    conversationId: (event as any)?.data?.conversation_id,
  });

  // Acknowledge ElevenLabs immediately so it doesn't retry; do the heavy
  // analysis + DB writes + next-lead trigger in the background.
  after(async () => {
    try {
      await handleElevenLabsWebhook(event);
    } catch (err) {
      // Log the full event so manual recovery is possible. ElevenLabs
      // won't retry on its own. Search pm2 logs by conversation_id.
      const convId = (event as any)?.data?.conversation_id;
      console.error(
        `[ELEVENLABS WEBHOOK] background handler failed (conversation_id=${convId}) — event follows for manual recovery:`,
        err,
        JSON.stringify(event),
      );
    }
  });

  return NextResponse.json({ received: true });
}
