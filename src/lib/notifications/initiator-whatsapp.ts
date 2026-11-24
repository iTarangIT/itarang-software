/**
 * 23 Nov 2026 (Battery Pool) — "send notifications for every important status
 * change". The dealer already hears every NBFC milestone on WhatsApp (B14 hook
 * in emit()), and iTarang admins get the bell + email. The one person left
 * out was the iTarang SALESPERSON who sent the file on WhatsApp in the first
 * place: after "Submit to iTarang" they heard nothing more.
 *
 * emit() now also calls pushInitiatorWhatsApp(): for the milestone types below
 * it WhatsApps the lead's initiator — the iTarang sales person recorded on the
 * lead's dealer check (lead_dealer_reviews.initiator_wa_phone, else the
 * initiating login's users.phone). Fire-and-forget; never throws.
 */
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leadDealerReviews, leads, users } from "@/lib/db/schema";

/** The milestones the salesperson hears about. Pure — exported for the test. */
export const INITIATOR_WHATSAPP_TYPES: ReadonlySet<string> = new Set([
  "nbfc.credit_approved",
  "nbfc.application_rejected",
  "loan.rejected_by_nbfc",
  // loan.offer_submitted is NOT here: pushOfferToWhatsApp (offer-flow.ts)
  // sends the salesperson the offer itself, with an "Accept offer" button.
  "loan.winner_selected",
  "loan.sanctioned",
  "loan.disbursed",
  "agreement.signed",
  "fi.reviewed",
  "vkyc.approved",
  "vkyc.rejected",
  "enach.confirmed",
  "enach.failed",
  "nbfc.request_forwarded",
  "lead.recalled",
  "lead.resubmitted",
  "lead.resumed",
  "kyc.auto_approved",
]);

export function isInitiatorWhatsAppType(type: string): boolean {
  return INITIATOR_WHATSAPP_TYPES.has(type);
}

/** Plain-text body for the salesperson. Pure. */
export function buildInitiatorMessage(p: {
  title: string;
  message: string;
  reference: string;
  customer: string;
}): string {
  return [`*${p.title}*`, p.message, `Customer: ${p.customer}`, `Ref: ${p.reference}`].join("\n");
}

const recent = new Map<string, number>();
const DEDUPE_MS = 10 * 60 * 1000;

export async function pushInitiatorWhatsApp(input: {
  type: string;
  title: string;
  message: string;
  leadId?: string | null;
}): Promise<void> {
  const leadId = input.leadId;
  if (!leadId || !isInitiatorWhatsAppType(input.type)) return;
  const key = `${input.type}|${leadId}|${input.title}`;
  const now = Date.now();
  const last = recent.get(key);
  if (last && now - last < DEDUPE_MS) return;

  try {
    const [review] = await db
      .select({
        phone: leadDealerReviews.initiator_wa_phone,
        userId: leadDealerReviews.initiated_by_user_id,
      })
      .from(leadDealerReviews)
      .where(eq(leadDealerReviews.lead_id, leadId))
      .orderBy(desc(leadDealerReviews.created_at))
      .limit(1);
    if (!review) return;
    let phone = review.phone ?? null;
    if (!phone && review.userId) {
      const [u] = await db.select({ phone: users.phone }).from(users).where(eq(users.id, review.userId)).limit(1);
      phone = u?.phone ?? null;
    }
    if (!phone) return;
    // Marked only once there is someone to send to, so an event that fired
    // before the salesperson was known does not swallow a later one.
    recent.set(key, now);
    if (recent.size > 500) {
      for (const [k, t] of recent) if (now - t >= DEDUPE_MS) recent.delete(k);
    }

    const [lead] = await db
      .select({ full_name: leads.full_name, owner_name: leads.owner_name, reference_id: leads.reference_id })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    const customer = lead?.full_name ?? lead?.owner_name ?? "Customer";
    const reference = lead?.reference_id || leadId;
    const { sendStaffWhatsApp } = await import("@/lib/whatsapp/staff-notify");
    await sendStaffWhatsApp(phone, buildInitiatorMessage({ ...input, customer, reference }), {
      customer,
      ref: reference,
      what: input.title,
    });
  } catch (err) {
    console.error(`[notify] initiator WhatsApp for ${input.type} lead=${leadId} failed:`, err);
  }
}
