import { handleBolnaWebhook } from "@/lib/ai/bolna_ai";
import {
  verifyBolnaWebhook,
  WebhookSecretMissingError,
  WebhookSignatureInvalidError,
} from "@/lib/ai/bolna_ai/signature";
import { after, NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    verifyBolnaWebhook(req);
  } catch (err) {
    if (err instanceof WebhookSecretMissingError) {
      console.error(
        "[bolna:webhook] BOLNA_WEBHOOK_SECRET is not configured — rejecting. " +
          "Set this env var and configure Bolna to send Authorization: Bearer <secret>.",
      );
      return NextResponse.json(
        { success: false, error: "Webhook not configured" },
        { status: 401 },
      );
    }
    if (err instanceof WebhookSignatureInvalidError) {
      console.warn("[bolna:webhook] auth failed:", err.message);
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }
    throw err;
  }

  try {
    const body = await req.json();

    console.log("WEBHOOK HIT", JSON.stringify({
      status: body.status,
      hasTranscript: !!body.transcript,
      phone: body.user_number || body.recipient_phone_number,
      keys: Object.keys(body),
    }));

    // Acknowledge Bolna immediately so it doesn't retry; do the heavy
    // analysis + DB writes + next-lead trigger in the background.
    after(async () => {
      try {
        await handleBolnaWebhook(body);
      } catch (err) {
        // Log the full payload so manual recovery is possible — Bolna's
        // delivery semantics mean the event won't be retried by them. Until
        // we add a webhook_processing_failures table, the pm2 log is the
        // only artifact. Search by call_id to find a specific failed event.
        const callId = body?.id || body?.execution_id || body?.run_id;
        console.error(
          `[bolna:webhook] background handler failed (call_id=${callId}) — payload follows for manual recovery:`,
          err,
          JSON.stringify(body),
        );
      }
    });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("API error:", err);

    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 },
    );
  }
}
