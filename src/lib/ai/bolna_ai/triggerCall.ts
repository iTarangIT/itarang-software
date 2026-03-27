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

        user_data: {
          leadId: payload.leadId,
          name: ownerName,
          location: location,
          memory: JSON.stringify(memory),
          interest: interest,
          status: status,
        },

        agent_data: {
          voice_id: "Vikram",
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
