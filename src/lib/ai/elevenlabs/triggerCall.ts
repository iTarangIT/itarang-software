import { db } from "@/lib/db";
import { dealerLeads, scraperLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ElevenLabsCallPayload, ElevenLabsCallResponse } from "./types";

// ElevenLabs has separate outbound endpoints depending on how the phone
// number is provisioned. Default to Twilio for backward compatibility;
// set ELEVENLABS_PHONE_PROVIDER=sip when the number under
// ELEVENLABS_AGENT_PHONE_NUMBER_ID is a SIP Trunk number.
function getOutboundUrl(): string {
  const provider = (process.env.ELEVENLABS_PHONE_PROVIDER || "twilio")
    .toLowerCase()
    .trim();
  if (provider === "sip" || provider === "sip-trunk" || provider === "sip_trunk") {
    return "https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call";
  }
  return "https://api.elevenlabs.io/v1/convai/twilio/outbound-call";
}

function deriveInterest(status: string | null): string {
  if (!status) return "cold";
  const s = status.toLowerCase().trim();
  if (["interested", "approved", "hot"].includes(s)) return "hot";
  if (["contacted", "warm", "callback_requested"].includes(s)) return "warm";
  return "cold";
}

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

async function promoteScraperLead(phone: string): Promise<any | null> {
  const [scraperLead] = await db
    .select()
    .from(scraperLeads)
    .where(eq(scraperLeads.phone, phone))
    .limit(1);

  if (!scraperLead) return null;

  console.log(
    "[ELEVENLABS] Scraper lead found, promoting to dealer_leads:",
    scraperLead.id,
  );

  const newId = `L-${nanoid(8)}`;

  await db.insert(dealerLeads).values({
    id: newId,
    dealer_name: scraperLead.name ?? null,
    shop_name: scraperLead.name ?? null,
    phone: scraperLead.phone ?? null,
    location: scraperLead.city ?? null,
    language: "hindi",
    current_status: "new",
    total_attempts: 0,
    follow_up_history: [],
    created_at: new Date(),
    provider: "elevenlabs",
  });

  await db
    .update(scraperLeads)
    .set({ status: "pushed" })
    .where(eq(scraperLeads.id, scraperLead.id));

  console.log(
    "[ELEVENLABS] Promoted scraper lead to dealer_leads with id:",
    newId,
  );

  const [newLead] = await db
    .select()
    .from(dealerLeads)
    .where(eq(dealerLeads.id, newId))
    .limit(1);

  return newLead ?? null;
}

export async function triggerElevenLabsCall(
  payload: ElevenLabsCallPayload,
): Promise<ElevenLabsCallResponse> {
  try {
    if (!process.env.ELEVENLABS_API_KEY) {
      console.warn("[ELEVENLABS] API key not configured — call disabled");
      return { success: false, error: "ElevenLabs disabled (no API key)" };
    }
    if (!process.env.ELEVENLABS_AGENT_ID) {
      return { success: false, error: "ELEVENLABS_AGENT_ID not configured" };
    }
    if (!process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID) {
      return {
        success: false,
        error: "ELEVENLABS_AGENT_PHONE_NUMBER_ID not configured",
      };
    }

    let lead = await db.query.dealerLeads.findFirst({
      where: (l, { eq }) => eq(l.phone, payload.phone),
    });

    if (!lead) {
      console.log(
        "[ELEVENLABS] Not found in dealer_leads, checking scraper_leads for:",
        payload.phone,
      );
      lead = await promoteScraperLead(payload.phone);
    }

    if (!lead) {
      console.error(
        "[ELEVENLABS] Lead not found anywhere for phone:",
        payload.phone,
      );
      return { success: false, error: "Lead not found" };
    }

    if (!lead.dealer_name)
      console.warn(
        "[ELEVENLABS] WARNING: dealer_name is null for:",
        payload.phone,
      );
    if (!lead.location)
      console.warn(
        "[ELEVENLABS] WARNING: location is null for:",
        payload.phone,
      );
    if (!lead.shop_name)
      console.warn(
        "[ELEVENLABS] WARNING: shop_name is null for:",
        payload.phone,
      );

    const ownerName = lead.dealer_name?.trim() ?? "";
    const location = lead.location?.trim() ?? "";
    const shopName = lead.shop_name?.trim() ?? "";
    const language = lead.language?.trim() ?? "";
    const status = lead.current_status?.trim() ?? "";
    const interest = deriveInterest(lead.current_status);
    const totalAttempts = lead.total_attempts ?? 0;

    const followUpHistory = Array.isArray(lead.follow_up_history)
      ? lead.follow_up_history
      : [];
    const lastCallMemory = buildLastCallMemory(followUpHistory);
    const isFollowup = followUpHistory.length > 0;
    const persistentMemory = lead.memory ? JSON.stringify(lead.memory) : "";

    const dynamicVariables = {
      lead_id: lead.id,
      phone_number: payload.phone,
      owner_name: ownerName,
      location,
      shop_name: shopName,
      language,
      interest,
      status,
      total_attempts: String(totalAttempts),
      is_followup: String(isFollowup),
      last_call_memory: lastCallMemory,
      persistent_memory: persistentMemory,
      timezone: "Asia/Kolkata",
    };

    const bodyData = {
      agent_id: process.env.ELEVENLABS_AGENT_ID,
      agent_phone_number_id: process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID,
      to_number: payload.phone,
      conversation_initiation_client_data: {
        dynamic_variables: dynamicVariables,
      },
      call_recording_enabled: true,
    };

    const outboundUrl = getOutboundUrl();
    console.log("[ELEVENLABS PAYLOAD]", { url: outboundUrl, body: bodyData });

    const res = await fetch(outboundUrl, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyData),
    });

    const json: any = await res.json().catch(() => ({}));
    console.log("[ELEVENLABS RESPONSE]", JSON.stringify(json, null, 2));

    if (!res.ok || json?.success === false) {
      console.error("[ELEVENLABS] API error:", json);
      return {
        success: false,
        error:
          json?.message ||
          json?.detail?.message ||
          json?.error ||
          `ElevenLabs call failed (HTTP ${res.status})`,
      };
    }

    // Tag the lead so future cron / webhook flows know which provider owns it
    await db
      .update(dealerLeads)
      .set({ provider: "elevenlabs" })
      .where(eq(dealerLeads.id, lead.id));

    const conversationId =
      json?.conversation_id ?? json?.callSid ?? undefined;

    console.log("[ELEVENLABS] Queued. conversation_id:", conversationId);
    return {
      success: true,
      call_id: conversationId,
    };
  } catch (err: any) {
    console.error("[ELEVENLABS] triggerCall error:", err);
    return { success: false, error: err.message };
  }
}
