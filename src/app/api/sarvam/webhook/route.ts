// Sarvam Instant Outbound call-end webhook.
//
// Sarvam posts once per attempt, connected or not. Check the URL token,
// answer 200 straight away, and do the post-call work in after() — the
// finalize pipeline (transcript analysis, ai_call_logs, dispositions,
// advancing the campaign) can take longer than a webhook sender waits.

import { after, NextRequest, NextResponse } from "next/server";
import { handleSarvamWebhook } from "@/lib/ai/sarvam/webhookHandler";
import { sarvamWebhookTokenValid } from "@/lib/ai/sarvam/webhookAuth";
import type { SarvamWebhookPayload } from "@/lib/ai/sarvam/types";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!sarvamWebhookTokenValid(token, process.env.SARVAM_WEBHOOK_TOKEN)) {
    console.warn("[SARVAM WEBHOOK] rejected: missing or wrong token");
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  let payload: SarvamWebhookPayload;
  try {
    payload = (await req.json()) as SarvamWebhookPayload;
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 },
    );
  }

  if (!payload || typeof payload.attempt_id !== "string" || !payload.attempt_id) {
    return NextResponse.json(
      { success: false, error: "attempt_id is required" },
      { status: 400 },
    );
  }

  const receivedAt = new Date();
  after(async () => {
    try {
      await handleSarvamWebhook(payload, receivedAt);
    } catch (err) {
      console.error("[SARVAM WEBHOOK] after() handler failed:", err, {
        attemptId: payload.attempt_id,
        status: payload.status,
      });
    }
  });

  return NextResponse.json({ received: true });
}
