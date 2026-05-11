import { db } from "@/lib/db";
import { dealerLeads, scraperLeads } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { normalizeIndianPhone, phoneLookupVariants } from "@/lib/ai/phone";
import { dedupClaim } from "@/lib/queue/safeRedis";
import { BolnaCallPayload, BolnaCallResponse } from "./types";

// One Bolna call per (lead, phone, day). Stops QStash retries — which on a
// 5xx response can re-fire the dispatch up to 3 times — from billing 3x
// for one lead's daily outreach attempt. Cron and human triggers re-attempt
// the next day naturally because the key embeds today's UTC date.
const IDEMPOTENCY_TTL_SECONDS = 25 * 60 * 60;

function idempotencyKey(leadId: string, e164Phone: string): string {
  const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `bolna:idem:${leadId}:${e164Phone}:${dateKey}`;
}

// Eager-validate the three Bolna env vars on first use. Previously these
// were read inline at the fetch call, so a missing var would send a malformed
// payload to Bolna and surface as a cryptic API error. This pattern matches
// `getReceiver()` in src/app/api/bolna/dispatch-call/route.ts.
interface BolnaConfig {
  apiKey: string;
  agentId: string;
  fromNumber: string;
}
let cachedConfig: BolnaConfig | null = null;
function getBolnaConfig(): BolnaConfig {
  if (cachedConfig) return cachedConfig;
  const apiKey = process.env.BOLNA_API_KEY;
  const agentId = process.env.BOLNA_AGENT_ID;
  const fromNumber = process.env.BOLNA_FROM_NUMBER;
  const missing: string[] = [];
  if (!apiKey) missing.push("BOLNA_API_KEY");
  if (!agentId) missing.push("BOLNA_AGENT_ID");
  if (!fromNumber) missing.push("BOLNA_FROM_NUMBER");
  if (missing.length) {
    throw new Error(`Bolna config missing env vars: ${missing.join(", ")}`);
  }
  cachedConfig = { apiKey: apiKey!, agentId: agentId!, fromNumber: fromNumber! };
  return cachedConfig;
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

// ─── Auto-promote scraper lead → dealer_leads ─────────────────
async function promoteScraperLead(phone: string): Promise<any | null> {
  // dealer_leads stores 10-digit, scraper_leads stores +91 E.164 — look up
  // by both variants so we match regardless of which the caller passed.
  const variants = phoneLookupVariants(phone);
  const [scraperLead] = await db
    .select()
    .from(scraperLeads)
    .where(inArray(scraperLeads.phone, variants))
    .limit(1);

  if (!scraperLead) return null;

  console.log(
    "[BOLNA] Scraper lead found, promoting to dealer_leads:",
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
  });

  // Mark scraper lead as pushed
  await db
    .update(scraperLeads)
    .set({ status: "pushed" })
    .where(eq(scraperLeads.id, scraperLead.id));

  console.log("[BOLNA] Promoted scraper lead to dealer_leads with id:", newId);

  // Return the newly created dealer lead
  const [newLead] = await db
    .select()
    .from(dealerLeads)
    .where(eq(dealerLeads.id, newId))
    .limit(1);

  return newLead ?? null;
}

// ─── Main trigger function ────────────────────────────────────
export async function triggerBolnaCall(
  payload: BolnaCallPayload,
): Promise<BolnaCallResponse> {
  try {
    // Validate Bolna config up front — fail loudly instead of mid-flight.
    let bolnaConfig: BolnaConfig;
    try {
      bolnaConfig = getBolnaConfig();
    } catch (err: any) {
      console.error("[BOLNA]", err?.message);
      return { success: false, error: err?.message ?? "Bolna disabled" };
    }

    // Step 1: Look up in dealer_leads — try every storage variant of the
    // input phone so a +91 caller can find a 10-digit row and vice-versa.
    const lookupVariants = phoneLookupVariants(payload.phone);
    let lead = await db.query.dealerLeads.findFirst({
      where: (l, { inArray }) => inArray(l.phone, lookupVariants),
    });

    // Step 2: If not found, check scraper_leads and auto-promote
    if (!lead) {
      console.log(
        "[BOLNA] Not found in dealer_leads, checking scraper_leads for:",
        payload.phone,
      );
      lead = await promoteScraperLead(payload.phone);
    }

    if (!lead) {
      console.error(
        "[BOLNA] Lead not found anywhere for phone:",
        payload.phone,
      );
      return { success: false, error: "Lead not found" };
    }

    console.log("[DB DATA]", JSON.stringify(lead, null, 2));

    // Step 3: Warn if critical fields are missing
    if (!lead.dealer_name)
      console.warn("[BOLNA] WARNING: dealer_name is null for:", payload.phone);
    if (!lead.location)
      console.warn("[BOLNA] WARNING: location is null for:", payload.phone);
    if (!lead.shop_name)
      console.warn("[BOLNA] WARNING: shop_name is null for:", payload.phone);

    // Step 4: Map all DB fields
    const ownerName = lead.dealer_name?.trim() ?? "";
    const location = lead.location?.trim() ?? "";
    const shopName = lead.shop_name?.trim() ?? "";
    const language = lead.language?.trim() ?? "";
    const status = lead.current_status?.trim() ?? "";
    const interest = deriveInterest(lead.current_status);
    const totalAttempts = lead.total_attempts ?? 0;

    // Step 5: Build memory from follow_up_history
    const followUpHistory = Array.isArray(lead.follow_up_history)
      ? lead.follow_up_history
      : [];
    const lastCallMemory = buildLastCallMemory(followUpHistory);
    const isFollowup = followUpHistory.length > 0;

    // Step 6: Persistent memory
    const persistentMemory = lead.memory ? JSON.stringify(lead.memory) : "";

    console.log("[BOLNA] interest:", interest);
    console.log("[BOLNA] total_attempts:", totalAttempts);
    console.log("[BOLNA] is_followup:", isFollowup);
    console.log("[BOLNA] last_call_memory:", lastCallMemory);

    // Step 7: Build payload
    const recipientPhone = normalizeIndianPhone(lead.phone ?? payload.phone);
    if (!recipientPhone) {
      console.error(
        "[BOLNA] Invalid phone (cannot normalize to E.164):",
        lead.phone ?? payload.phone,
      );
      return {
        success: false,
        error:
          "Lead phone is invalid — expected 10 digits or +91XXXXXXXXXX format.",
      };
    }

    // Step 7b: Idempotency claim. Catches QStash retries firing the same
    // dispatch within 25 hours. Skip when scheduling for a future date —
    // those legitimately fire later and shouldn't be deduped against now.
    if (!payload.scheduledAt) {
      const idemKey = idempotencyKey(lead.id, recipientPhone);
      const { claimed } = await dedupClaim(
        idemKey,
        IDEMPOTENCY_TTL_SECONDS,
        "bolna:outbound-idem",
      );
      if (!claimed) {
        console.warn(
          `[BOLNA] Skipping duplicate call within 25h for lead ${lead.id} (${recipientPhone}) — idempotency key matched`,
        );
        return {
          success: true,
          deduped: true,
          error: "Duplicate call suppressed by idempotency key",
        } as BolnaCallResponse;
      }
    }

    const bodyData = {
      agent_id: bolnaConfig.agentId,
      recipient_phone_number: recipientPhone,
      from_phone_number: bolnaConfig.fromNumber,
      ...(payload.scheduledAt ? { scheduled_at: payload.scheduledAt } : {}),

      user_data: {
        lead_id: lead.id,
        phone_number: recipientPhone,
        owner_name: ownerName,
        location: location,
        shop_name: shopName,
        language: language,
        interest: interest,
        status: status,
        total_attempts: String(totalAttempts),
        is_followup: String(isFollowup),
        last_call_memory: lastCallMemory,
        persistent_memory: persistentMemory,
        timezone: "Asia/Kolkata",
      },
    };

    console.log("[BOLNA PAYLOAD]", JSON.stringify(bodyData, null, 2));

    // Step 8: Make API call
    const res = await fetch("https://api.bolna.ai/call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bolnaConfig.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyData),
    });

    const json = await res.json();
    console.log("[BOLNA RESPONSE]", JSON.stringify(json, null, 2));

    if (!res.ok) {
      console.error("[BOLNA] API error:", json);
      return {
        success: false,
        error: json?.message || json?.error || "Bolna call failed",
      };
    }

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
