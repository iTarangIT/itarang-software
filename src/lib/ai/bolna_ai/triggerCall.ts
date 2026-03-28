import { db } from "@/lib/db";
import { BolnaCallPayload, BolnaCallResponse } from "./types";

export async function triggerBolnaCall(
  payload: BolnaCallPayload,
): Promise<BolnaCallResponse> {
  try {
    const lead = await db.query.dealerLeads.findFirst({
      where: (l, { eq }) => eq(l.phone, payload.phone),
    });

    if (!lead) {
      return {
        success: false,
        error: "Lead not found",
      };
    }

    const ownerName = lead.dealer_name || "sir";
    const location = lead.location || "";
    const memory = lead.memory || {};
    const interest = lead.current_status || "cold";
    const status = lead.current_status || "new";

    console.log("Calling:", ownerName);
    console.log("Location:", location);
    console.log("Memory:", memory);

    const dynamicPrompt = `
You are Vikram, a friendly and natural sales executive from iTarang Technologies.

Speak like a real human, not a robot.

Start the conversation naturally:

Hello, Vikram bol raha hoon iTarang Technologies se.

${ownerName ? `${ownerName} ji bol rahe hain kya?` : "Sir, kya main aapse baat kar raha hoon?"}

${location ? `Aap ${location} se hain na?` : ""}

Continue the conversation naturally:
- Understand dealer needs
- Talk about lithium-ion batteries
- Keep tone friendly and human
- Do not sound scripted
- Keep responses short and conversational
`;

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

        agent_data: {
          voice_id: "Vikram",
          prompt: dynamicPrompt,
        },

        user_data: {
          lead_id: payload.leadId,
        },
      }),
    });

    const json = await res.json();

    console.log("Bolna response:", json);

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
