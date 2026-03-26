import { analyzeTranscript } from "@/lib/ai/analysis";
import { triggerBolnaCall } from "./triggerCall";
import { saveCallAttempt } from "../storage/callStore";
import { decideNextAction } from "../decision/engine";

function getValidDate(input: any): Date | null {
  if (!input) return null;

  const date = new Date(input);

  if (isNaN(date.getTime())) {
    return null;
  }

  return date;
}

export async function handleBolnaWebhook(body: any) {
  try {
    console.log("WEBHOOK HANDLER START");

    const transcript = body.transcript;
    const phone = body.user_number;
    const callId = body.id;
    const status = body.status;

    if (!transcript || status !== "completed") {
      console.log("Skipping non-completed event");
      return;
    }

    console.log("Processing call:", callId);

    const analysis = await analyzeTranscript(transcript);

    console.log("ANALYSIS RESULT:", analysis);

    let nextCallAt: Date | null = null;

    const parsedDate = getValidDate(analysis.callback_time);

    if (parsedDate) {
      nextCallAt = parsedDate;
    } else if (analysis.outcome === "callback_requested") {
      nextCallAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // +2 hours
    }

    await saveCallAttempt({
      leadId: "TEMP",
      phone,
      transcript,
      outcome: analysis.outcome,
      nextCallAt,
      analysis: analysis.analysis,
      intentScore: analysis.intent_score,
    });

    if (nextCallAt && !isNaN(nextCallAt.getTime())) {
      console.log("Scheduling callback at:", nextCallAt);

      await triggerBolnaCall({
        leadId: "TEMP",
        phone,
        scheduledAt: nextCallAt.toISOString(),
      });
    } else {
      console.log("Invalid or no callback time, skipping scheduling");
    }

    const decision = decideNextAction(analysis.intent_score);
    console.log("Decision" + decision);

    console.log("WEBHOOK HANDLER DONE");
  } catch (err) {
    console.error("Webhook handler error:", err);
  }
}
