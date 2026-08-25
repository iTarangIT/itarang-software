/**
 * E-264 — reaching the chat that belongs to a lead, from outside a turn.
 *
 * This generalises pushSignedConsentToWhatsApp, which found its session with a
 * jsonb match on context->'lead'->>'leadId' AND a HARD-CODED
 * `current_state = 'DC_LEAD_CONSENT_WAIT'`. That was correct for exactly one
 * caller and blocks every other one: a co-borrower request, an offer, a sanction
 * and a dispatch-ready notice each park the conversation somewhere different.
 *
 * WHO THE MESSAGE IS FOR.
 *
 * A lead that a DEALER created in their WhatsApp console is the dealer's file to
 * run. The customer in that flow never typed a word to us — the dealer sat with
 * them, photographed their documents and sent them in. Pushing "we need a
 * co-borrower" to that customer's own number reaches somebody who has no chat
 * with iTarang, no context and no way to act, while the dealer who is holding
 * the file hears nothing. So resolveLeadTarget() looks for the owning dealer's
 * chat FIRST, and falls back to the customer only when there isn't one — a
 * customer who self-onboarded through the house dealer, or a web-onboarded
 * dealer who has never used WhatsApp.
 *
 * Callers pass a FUNCTION of the resolved target wherever the wording differs:
 * a dealer must be told "your customer needs a co-borrower", not "you need a
 * co-borrower". Nothing downstream changes — authorizeLeadAction() already
 * admits the owning dealer's number on every journey button.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO.
 *
 * It does not assume the session is "on" the lead being pushed. A dealer runs
 * many leads through one WhatsApp number and ctx.lead holds exactly one pointer,
 * so a push for lead A arriving while they are mid-capture on lead B must not
 * hijack the conversation. That is why every prompt this sends carries an
 * id-bearing button (see ./leadActionButton) rather than moving the state
 * machine: the customer or dealer chooses when to switch leads, and the tap
 * re-hydrates the right one.
 */

import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";

import { phoneLookupVariants } from "@/lib/ai/phone";
import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  dealers,
  leads,
  whatsappOnboardingSessions,
} from "@/lib/db/schema";

import { resolveHouseDealer } from "./customer-lead";
import { getAdapter } from "./index";
import { logOutbound } from "./notifications";
import { sendOrPark, type NudgeSpec, type ParkedPrompt } from "./outbound";
import type { SessionRow } from "./session-store";
import { assertParamCount, resolveTemplate } from "./templates";
import { oneLine } from "./window";

/**
 * States in which a chat is genuinely sitting and waiting for something we are
 * about to deliver. Used only to PREFER such a session when several exist for
 * one lead — never to filter one out, because the id-bearing button works from
 * any state.
 */
export const LEAD_WAIT_STATES = [
  "DC_LEAD_CONSENT_WAIT",
  "DC_LEAD_CONSENT_OTP_WAIT",
  "DC_DOCREQ_WAIT",
  "DC_CB_WAIT",
  "DC_CB_LINK_WAIT",
  "DC_S4_GATE",
  "DC_S4_WAIT",
  "DC_S4_LINK_WAIT",
  "DC_OF_WAIT",
  "DC_SN_WAIT",
  "DC_DP_PRODUCT",
  "DC_DP_CHARGER",
  "DC_DP_WAIT",
] as const;

const leadIdExpr = sql`${whatsappOnboardingSessions.context} -> 'lead' ->> 'leadId'`;

/**
 * Find the conversation driving this lead.
 *
 * Backed by the expression index E-264 adds on the same jsonb path — without it
 * this is a sequential scan of every session row, which was tolerable at one
 * Digio-webhook call site and is not at five journey events per lead.
 */
export async function findLeadSession(
  leadId: string,
  opts?: { states?: readonly string[] },
): Promise<SessionRow | null> {
  const base = opts?.states?.length
    ? and(
        sql`${leadIdExpr} = ${leadId}`,
        inArray(whatsappOnboardingSessions.current_state, [...opts.states]),
      )
    : sql`${leadIdExpr} = ${leadId}`;

  const [row] = await db
    .select()
    .from(whatsappOnboardingSessions)
    .where(base)
    .orderBy(desc(whatsappOnboardingSessions.updated_at))
    .limit(1);
  return row ?? null;
}

/**
 * The chat to talk to about this lead.
 *
 * The jsonb pointer is only the FIRST place to look, and on a submitted lead it
 * is usually empty: finalizeLead() clears ctx.lead when the lead goes to the
 * admin queue, and showDealerMenu clears it again. So a WhatsApp-originated lead
 * that has been submitted — precisely the lead an admin is most likely to ask
 * documents for — has no session pointing at it at all.
 *
 * Hence the fallback to the phone numbers on the lead itself. A phone match is
 * weaker evidence (the person may be mid-conversation about something else) but
 * it is the difference between reaching the customer and silence.
 */
async function bestLeadSession(leadId: string): Promise<SessionRow | null> {
  const byPointer =
    (await findLeadSession(leadId, { states: LEAD_WAIT_STATES })) ??
    (await findLeadSession(leadId));
  if (byPointer) return byPointer;
  return await findSessionByLeadPhone(leadId);
}

/**
 * Find the customer's own chat from the phone number on the lead.
 *
 * `operator_file` rows are EXCLUDED: that kind carries an internal operator's
 * number while pointing at a dealer's application, so a reply lands with staff
 * and the message is not addressed to them.
 *
 * `operator_hub` rows are NOT excluded, only ranked below `dealer`. A number
 * that was once allowlisted keeps its hub row forever, and if the allowlist
 * entry is later deactivated that same row goes back to serving an ordinary
 * conversation — which is the customer's real chat, mislabelled by history.
 * Filtering on the label would silently skip it.
 */
export async function findSessionByLeadPhone(
  leadId: string,
): Promise<SessionRow | null> {
  const [lead] = await db
    .select({
      mobile: leads.mobile,
      phone: leads.phone,
      owner_contact: leads.owner_contact,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return null;

  const candidates = [lead.mobile, lead.phone, lead.owner_contact]
    .map((v) => toWaPhone(v))
    .filter((v): v is string => Boolean(v));

  return await newestSessionForPhones(candidates);
}

/** Newest usable chat on any of these Meta addresses, dealer rows ranked first. */
async function newestSessionForPhones(
  waPhones: string[],
): Promise<SessionRow | null> {
  const unique = [...new Set(waPhones)].filter(Boolean);
  if (unique.length === 0) return null;

  const [row] = await db
    .select()
    .from(whatsappOnboardingSessions)
    .where(
      and(
        inArray(whatsappOnboardingSessions.wa_phone, unique),
        ne(whatsappOnboardingSessions.session_kind, "operator_file"),
      ),
    )
    .orderBy(
      // 'dealer' first, then whatever else, newest inbound within each.
      sql`CASE WHEN ${whatsappOnboardingSessions.session_kind} = 'dealer' THEN 0 ELSE 1 END`,
      desc(whatsappOnboardingSessions.last_inbound_at),
    )
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Who the message is addressed to
// ---------------------------------------------------------------------------

export type LeadAudience = "dealer" | "customer";

export interface LeadPushTarget {
  leadId: string;
  /** "dealer" when the owning dealer is running this file over WhatsApp. */
  audience: LeadAudience;
  /** The name the prompt should greet — the dealer's, or the customer's. */
  greetName: string;
  /** The customer this lead is about, whoever is being written to. */
  customerName: string;
  referenceId: string;
  /** The chat to send into, or null when nobody has one yet (cold push). */
  session: SessionRow | null;
  /** Meta address for the cold template. */
  waPhone: string | null;
}

/**
 * The house dealer owns every SELF-onboarded customer lead, so its leads must
 * keep going to the customer. Resolved once — it is a fixed account — and only
 * a successful lookup is cached, so a transient failure cannot pin `null` for
 * the life of the process and silently reroute self-onboarded customers.
 */
let houseDealerCodeCache: string | null = null;
async function houseDealerCode(): Promise<string | null> {
  if (houseDealerCodeCache) return houseDealerCodeCache;
  try {
    const house = await resolveHouseDealer();
    if (house?.dealerCode) houseDealerCodeCache = house.dealerCode;
    return houseDealerCodeCache;
  } catch {
    return null;
  }
}

interface DealerChannel {
  waPhones: string[];
  name: string | null;
}

/**
 * Every Meta address the dealer who owns this lead might be chatting from.
 *
 * Both routes in are covered, exactly as resolveWhatsAppDealer() covers them for
 * the inbound direction: `dealer_onboarding_applications.wa_phone` for a dealer
 * who onboarded over WhatsApp, `dealers.owner_phone` for one who onboarded on
 * the web. Returns null for the house dealer — its leads are customers acting
 * for themselves, and there is no dealer sitting behind them.
 */
async function dealerChannelForLead(
  dealerCode: string | null | undefined,
): Promise<DealerChannel | null> {
  if (!dealerCode) return null;
  if (dealerCode === (await houseDealerCode())) return null;

  // ALL of them, not the first. One dealer_code can carry several approved
  // applications — a re-application, or an operator who filed for a dealer who
  // had also filed themselves — and in live data the newest of those is the one
  // whose wa_phone is null. Taking one row silently loses the dealer's number.
  const apps = await db
    .select({
      waPhone: dealerOnboardingApplications.wa_phone,
      ownerName: dealerOnboardingApplications.owner_name,
      companyName: dealerOnboardingApplications.company_name,
    })
    .from(dealerOnboardingApplications)
    .where(
      and(
        eq(dealerOnboardingApplications.dealer_code, dealerCode),
        eq(dealerOnboardingApplications.onboarding_status, "approved"),
        eq(dealerOnboardingApplications.dealer_account_status, "active"),
      ),
    )
    .orderBy(desc(dealerOnboardingApplications.created_at));
  const app = apps.find((a) => a.waPhone) ?? apps[0];

  const [row] = await db
    .select({
      ownerPhone: dealers.owner_phone,
      ownerName: dealers.owner_name,
      companyName: dealers.company_name,
    })
    .from(dealers)
    .where(
      and(
        eq(dealers.dealer_id, dealerCode),
        eq(dealers.onboarding_status, "active"),
      ),
    )
    .limit(1);

  const waPhones = [...apps.map((a) => a.waPhone), row?.ownerPhone]
    .flatMap((p) => (p ? [p, ...phoneLookupVariants(p)] : []))
    .map((p) => toWaPhone(p))
    .filter((p): p is string => Boolean(p));
  if (waPhones.length === 0) return null;

  // `dealers.owner_name` first: it is stamped at approval and names the DEALER.
  // An application's owner_name can be whoever filed it — an operator onboarding
  // a dealer on their behalf files under their own name (E-214), and greeting
  // the dealer by that name is greeting them as somebody else.
  return {
    waPhones: [...new Set(waPhones)],
    name:
      row?.ownerName ||
      app?.ownerName ||
      row?.companyName ||
      app?.companyName ||
      null,
  };
}

/**
 * Decide who hears about this lead, and in which chat.
 *
 * The dealer wins only when they actually have a WhatsApp chat with us. A
 * web-onboarded dealer who has never messaged the bot has a phone number but no
 * conversation, and cold-templating them would be a doorbell rung at somebody
 * who does not use this channel — so those leads keep the customer-first
 * resolution they have always had.
 */
export async function resolveLeadTarget(
  leadId: string,
): Promise<LeadPushTarget | null> {
  const [lead] = await db
    .select({
      reference_id: leads.reference_id,
      full_name: leads.full_name,
      owner_name: leads.owner_name,
      dealer_id: leads.dealer_id,
      mobile: leads.mobile,
      phone: leads.phone,
      owner_contact: leads.owner_contact,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return null;

  const customerName = lead.full_name || lead.owner_name || "there";
  const referenceId = lead.reference_id || leadId;

  const channel = await dealerChannelForLead(lead.dealer_id);
  if (channel) {
    const dealerSession = await newestSessionForPhones(channel.waPhones);
    if (dealerSession) {
      return {
        leadId,
        audience: "dealer",
        greetName: channel.name || "there",
        customerName,
        referenceId,
        session: dealerSession,
        waPhone: dealerSession.wa_phone || channel.waPhones[0] || null,
      };
    }
  }

  // No dealer chat — the original resolution. It can still land in a dealer's
  // chat (via the jsonb pointer, mid-capture), so classify by whose number the
  // session belongs to rather than by how we found it.
  const session = await bestLeadSession(leadId);
  const isDealerChat = Boolean(
    session?.wa_phone && channel?.waPhones.includes(session.wa_phone),
  );
  return {
    leadId,
    audience: isDealerChat ? "dealer" : "customer",
    greetName: isDealerChat ? channel?.name || "there" : customerName,
    customerName,
    referenceId,
    session,
    waPhone:
      session?.wa_phone ||
      toWaPhone(lead.phone || lead.mobile || lead.owner_contact),
  };
}

export type PushResult = "session" | "cold" | "none";

export interface LeadMessage {
  prompt: ParkedPrompt;
  nudge: NudgeSpec;
}

/**
 * A message, or a way to word one once we know who is receiving it. Pass the
 * function form wherever dealer-facing and customer-facing copy differ.
 */
export type LeadMessageSpec =
  | LeadMessage
  | ((target: LeadPushTarget) => LeadMessage);

/**
 * Deliver a journey prompt to whoever is driving this lead.
 *
 *   "session" — a chat exists; the prompt was sent, or parked behind a nudge
 *   "cold"    — no chat exists, so only the template went out. The reply creates
 *               the session, and the button in the template (or their "hi")
 *               picks the journey up from there.
 *   "none"    — unreachable: no session, no usable phone, or no approved
 *               template. Caller should fall back to email/SMS/the dealer.
 *
 * Best-effort by contract. Callers hang this off the side of an already-
 * committed action (`void pushX(...).catch(() => {})`), so it must never throw
 * and must never be the reason a sanction or a doc request fails.
 */
export async function pushToLead(
  leadId: string,
  msg: LeadMessageSpec,
): Promise<PushResult> {
  try {
    const target = await resolveLeadTarget(leadId);
    if (!target) return "none";
    const built = typeof msg === "function" ? msg(target) : msg;

    if (target.session) {
      await sendOrPark(target.session, built.prompt, built.nudge);
      return "session";
    }
    return await pushCold(target, built.nudge);
  } catch (err) {
    console.error(`[WhatsApp/lead-push] push for ${leadId} failed:`, err);
    return "none";
  }
}

/**
 * No conversation exists yet — template only, logged with a null session_id.
 *
 * There is nothing to park against, so the prompt is dropped and the template
 * has to stand alone. That is the one case where the doorbell must say enough
 * on its own to be worth answering.
 */
async function pushCold(
  target: LeadPushTarget,
  nudge: NudgeSpec,
): Promise<PushResult> {
  if (!target.waPhone) return "none";

  const tpl = resolveTemplate(nudge.template);
  if (!tpl) return "none";

  assertParamCount(nudge.template, nudge.params);
  const params = nudge.params.map((p) => oneLine(p));
  const res = await getAdapter().sendTemplate(
    target.waPhone,
    tpl.name,
    tpl.lang,
    params,
  );
  await logOutbound(null, res, {
    messageType: "template",
    textBody: params.join(" | "),
    templateName: tpl.name,
  });
  return res.ok ? "cold" : "none";
}

/**
 * Meta addresses are E.164 without the leading '+'. Lead phones in this database
 * are stored inconsistently — '+91XXXXXXXXXX' from the WhatsApp path, bare ten
 * digits from the web form — so normalise both, and refuse anything that is
 * neither rather than sending to a malformed address.
 */
export function toWaPhone(input: string | null | undefined): string | null {
  const digits = (input ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  return null;
}

/** Every session that mentions this lead — for admin views and diagnostics. */
export async function findAllLeadSessions(
  leadId: string,
): Promise<SessionRow[]> {
  return await db
    .select()
    .from(whatsappOnboardingSessions)
    .where(
      and(sql`${leadIdExpr} = ${leadId}`, isNotNull(whatsappOnboardingSessions.wa_phone)),
    )
    .orderBy(desc(whatsappOnboardingSessions.updated_at));
}
