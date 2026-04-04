import { db } from "@/lib/db";
import { dealerLeads, scraperLeads } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { BolnaCallPayload, BolnaCallResponse } from "./types";

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
  // Look up in scraper_leads by phone
  const [scraperLead] = await db
    .select()
    .from(scraperLeads)
    .where(eq(scraperLeads.phone, phone))
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
    // Step 1: Look up in dealer_leads first
    let lead = await db.query.dealerLeads.findFirst({
      where: (l, { eq }) => eq(l.phone, payload.phone),
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
    const bodyData = {
      agent_id: process.env.BOLNA_AGENT_ID,
      recipient_phone_number: payload.phone,
      from_phone_number: process.env.BOLNA_FROM_NUMBER,
      ...(payload.scheduledAt ? { scheduled_at: payload.scheduledAt } : {}),

      user_data: {
        lead_id: lead.id,
        phone_number: payload.phone,
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
        Authorization: `Bearer ${process.env.BOLNA_API_KEY}`,
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
