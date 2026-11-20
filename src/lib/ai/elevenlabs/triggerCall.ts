import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { normalizeIndianPhone, phoneLookupVariants } from "@/lib/ai/phone";
import { dedupClaim } from "@/lib/queue/safeRedis";
import { openingLanguageOverride } from "@/lib/ai-dialer/callLanguage";
import {
  DIAL_IDEMPOTENCY_TTL_SECONDS,
  dialIdempotencyKey,
  promoteScraperLead,
} from "@/lib/ai/dialerShared";
import { ElevenLabsCallPayload, ElevenLabsCallResponse } from "./types";
import { redialHints } from "@/lib/ai-dialer/dispositionV3";
import { lastDispositionRuleFor } from "@/lib/ai/storage/dialDisposition";
import { spokenNameFor } from "@/lib/ai-dialer/spokenNameStore";

// One ElevenLabs call per (lead, phone, day). Same rationale as Bolna —
// stops QStash retries from billing 3x for the same daily outreach attempt.
const IDEMPOTENCY_TTL_SECONDS = DIAL_IDEMPOTENCY_TTL_SECONDS;

function idempotencyKey(leadId: string, e164Phone: string): string {
  return dialIdempotencyKey("elevenlabs", leadId, e164Phone);
}

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

    // Look up by every storage variant of the input phone so a +91 caller
    // can find a 10-digit row and vice-versa during the format transition.
    const lookupVariants = phoneLookupVariants(payload.phone);
    // Dialling a captured owner / alternate number: the lead is the one asked
    // for, not whoever owns that number.
    let lead = payload.dialPhone && payload.leadId
      ? await db.query.dealerLeads.findFirst({
          where: (l, { eq }) => eq(l.id, payload.leadId),
        })
      : await db.query.dealerLeads.findFirst({
          where: (l, { inArray }) => inArray(l.phone, lookupVariants),
        });

    if (!lead) {
      console.log(
        "[ELEVENLABS] Not found in dealer_leads, checking scraper_leads for:",
        payload.phone,
      );
      lead = await promoteScraperLead(payload.phone, "elevenlabs");
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

    const recipientPhone = normalizeIndianPhone(payload.dialPhone ?? lead.phone ?? payload.phone);
    if (!recipientPhone) {
      console.error(
        "[ELEVENLABS] Invalid phone (cannot normalize to E.164):",
        lead.phone ?? payload.phone,
      );
      return {
        success: false,
        error:
          "Lead phone is invalid — expected 10 digits or +91XXXXXXXXXX format.",
      };
    }

    // Idempotency: skip duplicate dispatches within 25 hours for the same
    // (lead, phone) pair. Bypassed when scheduling for a future date —
    // those legitimately fire later and shouldn't be deduped against now —
    // or when the caller is a deliberate re-call (bypassIdempotency).
    if (!payload.scheduledAt && !payload.bypassIdempotency) {
      const idemKey = idempotencyKey(lead.id, recipientPhone);
      const { claimed } = await dedupClaim(
        idemKey,
        IDEMPOTENCY_TTL_SECONDS,
        "elevenlabs:outbound-idem",
      );
      if (!claimed) {
        console.warn(
          `[ELEVENLABS] Skipping duplicate call within 25h for lead ${lead.id} (${recipientPhone}) — idempotency key matched`,
        );
        return {
          success: true,
          deduped: true,
          error: "Duplicate call suppressed by idempotency key",
        };
      }
    }

    const dynamicVariables = {
      lead_id: lead.id,
      phone_number: recipientPhone,
      owner_name: ownerName,
      location,
      shop_name: shopName,
      // AI dialer list item 3 — the short name the agent says ("Bansal Battery
      // House", not the full Maps title). A rep's override wins (E-378).
      shop_name_spoken: await spokenNameFor({ id: lead.id, shop_name: lead.shop_name }),
      language,
      interest,
      status,
      total_attempts: String(totalAttempts),
      is_followup: String(isFollowup),
      last_call_memory: lastCallMemory,
      persistent_memory: persistentMemory,
      timezone: "Asia/Kolkata",
      // Dispositions v3 — how the last dial ended shapes this one's opening.
      ...redialHints(await lastDispositionRuleFor(lead.id)),
    };

    // Item 2 (3 Nov 2026) — open in the dealer's own language when an earlier
    // call learned it. ElevenLabs REJECTS the call unless the agent allows a
    // language override (platform_settings.overrides), so it is switched on
    // with ELEVENLABS_LANGUAGE_OVERRIDE=1 only once the agent is set up; the
    // language preset then supplies that language's first message.
    const languageOverride =
      process.env.ELEVENLABS_LANGUAGE_OVERRIDE === "1"
        ? openingLanguageOverride(lead.language)
        : null;

    const bodyData = {
      agent_id: process.env.ELEVENLABS_AGENT_ID,
      agent_phone_number_id: process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID,
      to_number: recipientPhone,
      conversation_initiation_client_data: {
        dynamic_variables: dynamicVariables,
        ...(languageOverride
          ? { conversation_config_override: { agent: { language: languageOverride } } }
          : {}),
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
