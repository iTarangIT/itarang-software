// Thin adapter: receives a raw Bolna webhook body, normalizes it into the
// shared finalize payload, and hands off to finalizeBolnaCall. All the post-
// call work (analysis, scoring, ai_call_logs upsert, completeCampaignLead,
// next-lead trigger) lives in finalizeCall.ts so the polling backstop can
// run the exact same code path.

import { finalizeBolnaCall } from "./finalizeCall";

export async function handleBolnaWebhook(body: any) {
  try {
    const { transcript, user_number: phone, status } = body;
    const callId = body.id || body.execution_id || body.run_id || "";
    const recordingUrl =
      body.recording_url || body.recording || body.audio_url || null;
    const duration =
      typeof body.duration === "number"
        ? body.duration
        : typeof body.call_duration === "number"
          ? body.call_duration
          : typeof body.conversation_duration === "number"
            ? body.conversation_duration
            : null;

    console.log("[WEBHOOK] Received:", {
      phone,
      status,
      callId,
      hasTranscript: !!transcript,
    });

    await finalizeBolnaCall({
      callId,
      status: status ?? "",
      transcript: transcript ?? null,
      recordingUrl,
      duration,
      phone: phone ?? null,
      conversation: body.messages ?? undefined,
      executionId: body.execution_id ?? body.call_id ?? callId,
    });
  } catch (err) {
    console.error("[bolna:webhook] handler error:", err);
  }
}
