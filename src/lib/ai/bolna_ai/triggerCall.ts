import { db } from "@/lib/db";
import { BolnaCallPayload, BolnaCallResponse } from "./types";

// ✅ Derived dynamically from DB current_status — no hardcoding
function deriveInterest(status: string | null): string {
  if (!status) return "cold";
  const s = status.toLowerCase().trim();
  if (["interested", "approved", "hot"].includes(s)) return "hot";
  if (["contacted", "warm", "callback_requested"].includes(s)) return "warm";
  return "cold";
}

// ✅ Build last call memory purely from follow_up_history data
function buildLastCallMemory(followUpHistory: any[]): string {
  if (!Array.isArray(followUpHistory) || followUpHistory.length === 0)
    return "";

  const lastCall = followUpHistory[followUpHistory.length - 1];
  if (!lastCall) return "";

  const parts: string[] = [];

  if (lastCall.outcome) parts.push(`Last outcome: ${lastCall.outcome}.`);

  if (lastCall.transcript && typeof lastCall.transcript === "string") {
    const trimmed = lastCall.transcript.trim();
    if (trimmed.length > 0 && trimmed.length <= 300) {
      parts.push(`Last call transcript: "${trimmed}"`);
    }
  }

  if (lastCall.analysis?.intent_score != null) {
    parts.push(`Intent score: ${lastCall.analysis.intent_score}/100.`);
  }

  if (lastCall.memory) {
    const m = lastCall.memory;
    if (m.requirement) parts.push(`Requirement: ${m.requirement}.`);
    if (m.quantity) parts.push(`Quantity mentioned: ${m.quantity}.`);
    if (m.product_interest)
      parts.push(`Product interest: ${m.product_interest}.`);
    if (m.intent_summary) parts.push(`Summary: ${m.intent_summary}`);
    if (m.followup_reason) parts.push(`Follow-up reason: ${m.followup_reason}`);
  }

  return parts.join(" ").trim();
}

export async function triggerBolnaCall(
  payload: BolnaCallPayload,
): Promise<BolnaCallResponse> {
  try {
    // ✅ Step 1: Fetch lead from DB
    const lead = await db.query.dealerLeads.findFirst({
      where: (l, { eq }) => eq(l.phone, payload.phone),
    });

    console.log("[DB DATA]", JSON.stringify(lead, null, 2));

    if (!lead) {
      console.error("[BOLNA] Lead not found for phone:", payload.phone);
      return { success: false, error: "Lead not found" };
    }

    // ✅ Step 2: Warn if critical fields are missing
    if (!lead.dealer_name) {
      console.warn("[BOLNA] WARNING: dealer_name is null for:", payload.phone);
    }
    if (!lead.location) {
      console.warn("[BOLNA] WARNING: location is null for:", payload.phone);
    }
    if (!lead.shop_name) {
      console.warn("[BOLNA] WARNING: shop_name is null for:", payload.phone);
    }

    // ✅ Step 3: Map all DB fields dynamically — no fallback hardcoding
    const ownerName = lead.dealer_name?.trim() ?? "";
    const location = lead.location?.trim() ?? "";
    const shopName = lead.shop_name?.trim() ?? "";
    const language = lead.language?.trim() ?? "";
    const status = lead.current_status?.trim() ?? "";
    const interest = deriveInterest(lead.current_status);
    const totalAttempts = lead.total_attempts ?? 0;

    // ✅ Step 4: Build memory from follow_up_history
    const followUpHistory = Array.isArray(lead.follow_up_history)
      ? lead.follow_up_history
      : [];
    const lastCallMemory = buildLastCallMemory(followUpHistory);
    const isFollowup = followUpHistory.length > 0;

    // ✅ Step 5: Build memory context from lead.memory (persistent memory)
    const persistentMemory = lead.memory ? JSON.stringify(lead.memory) : "";

    console.log("[BOLNA] interest:", interest);
    console.log("[BOLNA] total_attempts:", totalAttempts);
    console.log("[BOLNA] is_followup:", isFollowup);
    console.log("[BOLNA] last_call_memory:", lastCallMemory);

    // ✅ Step 6: Build payload — all values from DB, nothing hardcoded
    const bodyData = {
      agent_id: process.env.BOLNA_AGENT_ID,
      recipient_phone_number: payload.phone,
      from_phone_number: process.env.BOLNA_FROM_NUMBER,
      ...(payload.scheduledAt ? { scheduled_at: payload.scheduledAt } : {}),

      user_data: {
        lead_id: lead.id,
        phone_number: payload.phone,
        owner_name: ownerName, // → {owner_name}
        location: location, // → {location}
        shop_name: shopName, // → {shop_name}
        language: language, // → {language}
        interest: interest, // → {interest}
        status: status, // → {status}
        total_attempts: String(totalAttempts), // → {total_attempts}
        is_followup: String(isFollowup), // → {is_followup}
        last_call_memory: lastCallMemory, // → {last_call_memory}
        persistent_memory: persistentMemory, // → {persistent_memory}
        timezone: "Asia/Kolkata",
      },
    };

    console.log("[BOLNA PAYLOAD]", JSON.stringify(bodyData, null, 2));

    // ✅ Step 7: Make API call
    const res = await fetch("https://api.bolna.ai/call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.BOLNA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyData),
    });

    const json = await res.json();
    console.log("[BOLNA RESPONSE]", JSON.stringify(json, null, 2));

    // ✅ Step 8: Handle error
    if (!res.ok) {
      console.error("[BOLNA] API error:", json);
      return {
        success: false,
        error: json?.message || json?.error || "Bolna call failed",
      };
    }

    // ✅ Step 9: Return execution_id
    console.log("[BOLNA] Queued. execution_id:", json?.execution_id);
    return {
      success: true,
      call_id: json?.execution_id,
    };
  } catch (err: any) {
    console.error("[BOLNA] triggerCall error:", err);
    return { success: false, error: err.message };
  }
}
