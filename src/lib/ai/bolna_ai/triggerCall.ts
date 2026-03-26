import { BolnaCallPayload, BolnaCallResponse } from "./types";

export async function triggerBolnaCall(
  payload: BolnaCallPayload,
): Promise<BolnaCallResponse> {
  try {
    const res = await fetch("https://api.bolna.ai/call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.BOLNA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent_id: process.env.BOLNA_AGENT_ID,
        recipient_phone_number: payload.phone,
        from_phone_number: process.env.BOLNA_FROM_NUMBER,

        scheduled_at: payload.scheduledAt || undefined,

        user_data: {
          leadId: payload.leadId,
          name: payload.name || "Dealer",
        },

        agent_data: {
          voice_id: "Sam",
        },
      }),
    });

    const json = await res.json();

    if (!res.ok) {
      return {
        success: false,
        error: json?.error || "Bolna call failed",
      };
    }

    return {
      success: true,
      call_id: json?.call_id,
    };
  } catch (err: any) {
    console.error("[BOLNA] triggerCall error:", err);

    return {
      success: false,
      error: err.message,
    };
  }
}
