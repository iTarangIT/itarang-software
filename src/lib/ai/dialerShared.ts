// Provider-agnostic pieces of placing an AI dialer call, shared by the
// ElevenLabs and Sarvam triggers. Lifted out of elevenlabs/triggerCall.ts
// unchanged apart from the provider parameter.

import { db } from "@/lib/db";
import { recordLeadCreated, stampLeadSource } from "@/lib/leads/leadSource";
import { dealerLeads, scraperLeads } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { phoneLookupVariants } from "@/lib/ai/phone";
import type { DialerProvider } from "@/lib/ai/providers";

// One call per (provider, lead, phone, day): stops QStash / retry re-entry
// from billing several times for the same daily outreach attempt.
export const DIAL_IDEMPOTENCY_TTL_SECONDS = 25 * 60 * 60;

export function dialIdempotencyKey(
  provider: DialerProvider,
  leadId: string,
  e164Phone: string,
): string {
  const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${provider}:idem:${leadId}:${e164Phone}:${dateKey}`;
}

export async function promoteScraperLead(
  phone: string,
  provider: DialerProvider,
): Promise<any | null> {
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
    `[${provider}] Scraper lead found, promoting to dealer_leads:`,
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
    provider,
  });

  // ID 81: a scraper record promoted on dial — Entered via Scraper, Found via
  // Scraped listing, and "Lead created". Best-effort; the lead exists either way.
  await stampLeadSource(db, newId, { door: "scraper", origin: "scraped_listing" });
  await recordLeadCreated(db, { leadId: newId, actorId: null, door: "scraper", ownerId: null }).catch((e) =>
    console.warn("[triggerCall] Lead created not recorded:", e),
  );

  await db
    .update(scraperLeads)
    .set({ status: "pushed" })
    .where(eq(scraperLeads.id, scraperLead.id));

  console.log(
    `[${provider}] Promoted scraper lead to dealer_leads with id:`,
    newId,
  );

  const [newLead] = await db
    .select()
    .from(dealerLeads)
    .where(eq(dealerLeads.id, newId))
    .limit(1);

  return newLead ?? null;
}
