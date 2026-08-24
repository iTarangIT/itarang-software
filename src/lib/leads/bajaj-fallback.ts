// E-264 — what we tell a customer whose city has no preferred lending partner.
//
// loadSectionGOptions() runs the BRE, which matches loan products on state and
// city among other things. When it returns nothing, the honest answer is not
// "financing is unavailable" — Bajaj Finserv operates nationally and the
// customer can be served directly by their local Sales Manager. The lead is not
// dead; it just leaves our routing.
//
// The unserved city is RECORDED as well as answered. A list of the towns where
// customers asked and we had no partner is exactly the input a partnership team
// needs, and it only exists if something writes it down at the moment it happens.

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { auditLogs, leads } from "@/lib/db/schema";
import { createWorkflowId } from "@/lib/kyc/admin-workflow";

/** The nationally-available fallback. Not an NBFC row — we do not route to it. */
export const BAJAJ_FALLBACK = {
  name: "Bajaj Finserv",
  salesManagerPhone: "9217619585",
} as const;

/**
 * The exact wording to show when no preferred partner covers the customer's
 * area. Kept here rather than inline so the web portal and WhatsApp cannot
 * drift into telling the same customer two different things.
 */
export function bajajFallbackMessage(): string {
  return (
    `🏦 *${BAJAJ_FALLBACK.name} is available in your area.*\n\n` +
    `Reach out to your local Bajaj Sales Manager for any further details — ` +
    `you may contact *${BAJAJ_FALLBACK.salesManagerPhone}*.`
  );
}

/**
 * Record that this lead's area had no preferred partner.
 *
 * Written to audit_logs rather than a new table: it is a low-volume, append-only
 * observation about a lead, which is precisely what that table is for, and it
 * needs no migration to start collecting today. Query it later with
 * entity_type = 'no_preferred_partner'.
 *
 * Best-effort — never let bookkeeping break the customer's flow.
 */
export async function recordNoPreferredPartner(opts: {
  leadId: string;
  actorUserId?: string | null;
}): Promise<void> {
  try {
    const [lead] = await db
      .select({
        state: leads.state,
        city: leads.city,
        reference_id: leads.reference_id,
        full_name: leads.full_name,
        phone: leads.phone,
        mobile: leads.mobile,
        dealer_id: leads.dealer_id,
        source_channel: leads.source_channel,
      })
      .from(leads)
      .where(eq(leads.id, opts.leadId))
      .limit(1);
    if (!lead) return;

    const now = new Date();
    await db.insert(auditLogs).values({
      id: createWorkflowId("AUDIT", now),
      entity_type: "no_preferred_partner",
      entity_id: opts.leadId,
      action: "flagged",
      changes: {
        reference_id: lead.reference_id,
        state: lead.state,
        city: lead.city,
        customer_name: lead.full_name,
        // Kept so the partnership team can follow up without re-joining to
        // leads, which is the whole point of "store the details for later".
        contact: lead.phone ?? lead.mobile ?? null,
        dealer_id: lead.dealer_id,
        source_channel: lead.source_channel,
        fallback: BAJAJ_FALLBACK.name,
        sales_manager: BAJAJ_FALLBACK.salesManagerPhone,
      },
      performed_by: opts.actorUserId ?? null,
      timestamp: now,
    });
  } catch (err) {
    console.error("[bajaj-fallback] failed to record unserved city:", err);
  }
}
