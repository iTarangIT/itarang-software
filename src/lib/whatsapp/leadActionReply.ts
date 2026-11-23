/**
 * E-264 — claiming and authorising a journey button press.
 *
 * The impure half of the round trip; ./leadActionButton holds the pure parser.
 *
 * THE SECURITY BOUNDARY.
 *
 * Every wizard API route in this app protects a lead with requireLeadAccess(),
 * which reads a Supabase session. A WhatsApp turn has no session — the only
 * thing we know is the phone number Meta says the message came from. So
 * authorizeLeadAction() IS requireLeadAccess for this surface, and it is the
 * only thing standing between a guessed lead id and someone else's loan.
 *
 * It answers one question: may THIS phone number act on THIS lead? Two ways to
 * qualify, and nothing else counts:
 *   - the number belongs to the dealer who owns the lead, or
 *   - the number is the customer's own contact number on the lead.
 *
 * Note what is deliberately absent: possession of the button id proves nothing.
 * Button ids travel in forwarded screenshots and in group chats, and a lead id
 * is a short guessable string. The id says WHICH lead; the phone says WHETHER.
 */

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { leadDealerReviews, leads, users, whatsappOperators } from "@/lib/db/schema";

import {
  normalizeMobile,
  resolveDealerFinanceEnabled,
  resolveHouseDealer,
  type ActiveDealer,
} from "./customer-lead";
import { resolveWhatsAppDealer } from "./dealer-identity";
import {
  resolveDealerForSalesperson,
  resolveSalesperson,
} from "./salesperson-identity";
import { actorOf, recordLeadFlowEvent } from "./lead-events";
import { parseLeadAction, type LeadActionKey } from "./leadActionButton";
import { mergeContext, reply, type SessionRow } from "./session-store";
import type { InboundEvent } from "./types";

export type LeadActor =
  | { ok: true; actor: "dealer"; dealer: ActiveDealer }
  | { ok: true; actor: "customer"; dealer: ActiveDealer }
  | { ok: false };

/**
 * May this phone act on this lead?
 *
 * The customer arm still returns a dealer, because everything downstream — the
 * product catalogue, stock, the uploader_id on every document — is scoped to the
 * dealer who owns the lead. A self-serving customer acts THROUGH their dealer,
 * they do not act without one.
 */
export async function authorizeLeadAction(
  waPhone: string,
  leadId: string,
): Promise<LeadActor> {
  const [lead] = await db
    .select({
      id: leads.id,
      dealer_id: leads.dealer_id,
      uploader_id: leads.uploader_id,
      salesperson_id: leads.salesperson_id,
      mobile: leads.mobile,
      phone: leads.phone,
      owner_contact: leads.owner_contact,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  if (!lead || !lead.dealer_id) return { ok: false };

  // --- Dealer arm -------------------------------------------------------
  const waDealer = await resolveWhatsAppDealer(waPhone);
  if (waDealer && waDealer.dealerCode === lead.dealer_id) {
    return {
      ok: true,
      actor: "dealer",
      dealer: {
        dealerCode: waDealer.dealerCode,
        uploaderId: waDealer.dealerUserId ?? lead.uploader_id ?? "",
        dealerName: waDealer.dealerName ?? "your dealer",
        financeEnabled: waDealer.financeEnabled,
      },
    };
  }

  // --- Salesperson arm (E-277) ------------------------------------------
  // A dealer's salesperson may act, but only on a lead THEY created (own-leads
  // scope) — the same dealer_code alone is not enough. They act with the
  // dealer's identity plus the actor tag, exactly as in the console.
  const sp = await resolveSalesperson(waPhone);
  if (
    sp &&
    sp.dealerCode === lead.dealer_id &&
    lead.salesperson_id === sp.id
  ) {
    const spDealer = await resolveDealerForSalesperson(sp);
    if (spDealer) return { ok: true, actor: "dealer", dealer: spDealer };
  }

  // No second dealer lookup: resolveWhatsAppDealer already covers both routes
  // in, matching dealer_onboarding_applications.wa_phone for a WhatsApp-onboarded
  // dealer and dealers.owner_phone for a web-onboarded one.

  // --- Customer arm -----------------------------------------------------
  const caller = normalizeMobile(waPhone);
  if (caller) {
    const onLead = [lead.mobile, lead.phone, lead.owner_contact]
      .map((v) => normalizeMobile(v ?? ""))
      .filter(Boolean);
    if (onLead.includes(caller)) {
      const dealer = await dealerForLead(lead.dealer_id, lead.uploader_id);
      if (dealer) return { ok: true, actor: "customer", dealer };
    }
  }

  return { ok: false };
}

/**
 * Claim a journey button press.
 *
 * Returns true when the message was OURS and has been dealt with — the caller
 * must then stop, exactly like the E-243 quotation gate it is modelled on.
 * Returns false for anything that is not one of our button ids, so ordinary
 * text falls through to the state machine untouched.
 */
export async function handleLeadAction(
  session: SessionRow,
  event: InboundEvent,
): Promise<boolean> {
  const press = parseLeadAction(event.text);
  if (!press) return false;

  let auth = await authorizeLeadAction(event.waPhone, press.leadId);
  // 23 Nov 2026 (Battery Pool) — the iTarang salesperson who sent this file in
  // may open and ACCEPT its financing offer from their own WhatsApp. Offer
  // buttons only; every other journey action still needs the dealer or the
  // customer.
  let viaInitiator = false;
  if (!auth.ok && OFFER_ACTIONS.has(press.action)) {
    const dealer = await initiatorDealerForLead(event.waPhone, press.leadId);
    if (dealer) {
      auth = { ok: true, actor: "dealer", dealer };
      viaInitiator = true;
    }
  }
  if (!auth.ok) {
    // One message for every reason — wrong number, wrong lead, lead deleted.
    // Distinguishing them tells whoever is probing which lead ids are real.
    await reply(
      session,
      "This link is no longer valid. Please send *hi* to start again.",
    );
    return true;
  }

  const handler = LEAD_ACTION_HANDLERS[press.action];
  if (!handler) {
    // The phase that owns this action has not shipped yet. Say so plainly
    // rather than dropping the tap into silence.
    await reply(
      session,
      "That step isn't available on WhatsApp yet — your dealer will help you finish it.",
    );
    return true;
  }

  // Re-point the conversation at the lead this button names. A dealer runs many
  // leads through one number, so the tap — not the session — decides which one
  // we are talking about.
  await mergeContext(session, (ctx) => {
    ctx.lead = { ...(ctx.lead ?? {}), leadId: press.leadId };
    if (auth.actor === "customer") ctx.flow = "customer";
    // An internal operator's hub runs journey states only in the customer
    // flow (operator-orchestrator) — same as an operator-started customer KYC.
    if (viaInitiator && session.session_kind === "operator_hub") ctx.flow = "customer";
  });

  // E-278 — the tap itself onto the lead's history stream. This path runs in
  // runTurn BEFORE the console gate, so the console choke point never sees it;
  // the turns that follow inside the entered phase do go through the choke
  // point. Best-effort by contract (the recorder swallows all errors).
  await recordLeadFlowEvent({
    leadId: press.leadId,
    dealerCode: auth.dealer.dealerCode,
    action: `action:${press.action}`,
    ...(auth.actor === "customer"
      ? { actorKind: "customer" as const, salespersonId: null, actorLabel: null }
      : actorOf(auth.dealer)),
  });
  const fresh = { ...session };

  await handler(fresh, event, auth.dealer, press.leadId, press.arg);
  return true;
}

/**
 * Phase handlers register here. Kept as a mutable registry rather than a static
 * map so each phase module owns its own actions and this file never has to
 * import all four of them (which would recreate the import cycle the split
 * exists to avoid).
 */
export type LeadActionHandler = (
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
  leadId: string,
  arg?: string,
) => Promise<void>;

const LEAD_ACTION_HANDLERS: Partial<
  Record<LeadActionKey, LeadActionHandler>
> = {};

export function registerLeadAction(
  action: LeadActionKey,
  handler: LeadActionHandler,
): void {
  LEAD_ACTION_HANDLERS[action] = handler;
}

// --- helpers ------------------------------------------------------------

/** The journey actions the file's iTarang initiator may take (offer only). */
export const OFFER_ACTIONS: ReadonlySet<LeadActionKey> = new Set<LeadActionKey>(["of_view", "of_pick"]);

/**
 * 23 Nov 2026 — is this phone the iTarang salesperson who sent the lead in
 * (lead_dealer_reviews.initiator_wa_phone, or the initiating login's phone /
 * WhatsApp operator number)? Returns the lead's dealer to act through, else null.
 */
export async function initiatorDealerForLead(
  waPhone: string,
  leadId: string,
): Promise<ActiveDealer | null> {
  const caller = normalizeMobile(waPhone);
  if (!caller) return null;
  const [lead] = await db
    .select({ dealer_id: leads.dealer_id, uploader_id: leads.uploader_id })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead?.dealer_id) return null;
  const reviews = await db
    .select({
      phone: leadDealerReviews.initiator_wa_phone,
      userId: leadDealerReviews.initiated_by_user_id,
    })
    .from(leadDealerReviews)
    .where(eq(leadDealerReviews.lead_id, leadId));
  if (reviews.length === 0) return null;
  const phones: (string | null)[] = reviews.map((r) => r.phone);
  const userIds = [...new Set(reviews.map((r) => r.userId).filter((u): u is string => !!u))];
  if (userIds.length) {
    const us = await db.select({ phone: users.phone }).from(users).where(inArray(users.id, userIds));
    phones.push(...us.map((u) => u.phone));
    const ops = await db
      .select({ phone: whatsappOperators.wa_phone })
      .from(whatsappOperators)
      .where(and(inArray(whatsappOperators.user_id, userIds), eq(whatsappOperators.is_active, true)));
    phones.push(...ops.map((o) => o.phone));
  }
  const match = phones.some((p) => p && normalizeMobile(p) === caller);
  if (!match) return null;
  return await dealerForLead(lead.dealer_id, lead.uploader_id);
}

/**
 * The dealer that owns a lead, as an ActiveDealer. Falls back to the house
 * dealer only when the lead's own dealer cannot be resolved — a self-serve lead
 * sitting in the holding pen is the normal case for that.
 */
async function dealerForLead(
  dealerCode: string,
  uploaderId: string | null,
): Promise<ActiveDealer | null> {
  const house = await resolveHouseDealer();
  if (house && house.dealerCode === dealerCode) return house;
  if (!uploaderId) return house;
  return {
    dealerCode,
    uploaderId,
    dealerName: "your dealer",
    financeEnabled: await resolveDealerFinanceEnabled(dealerCode),
  };
}

/** Exported for tests / diagnostics: is this action wired up yet? */
export function isLeadActionImplemented(action: LeadActionKey): boolean {
  return Boolean(LEAD_ACTION_HANDLERS[action]);
}
