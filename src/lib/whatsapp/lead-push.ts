/**
 * E-264 — reaching the chat that belongs to a lead, from outside a turn.
 *
 * This generalises pushSignedConsentToWhatsApp, which found its session with a
 * jsonb match on context->'lead'->>'leadId' AND a HARD-CODED
 * `current_state = 'DC_LEAD_CONSENT_WAIT'`. That was correct for exactly one
 * caller and blocks every other one: a co-borrower request, an offer, a sanction
 * and a dispatch-ready notice each park the conversation somewhere different.
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

import { db } from "@/lib/db/index";
import {
  leads,
  whatsappOnboardingSessions,
} from "@/lib/db/schema";

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
  if (candidates.length === 0) return null;

  const [row] = await db
    .select()
    .from(whatsappOnboardingSessions)
    .where(
      and(
        inArray(whatsappOnboardingSessions.wa_phone, [...new Set(candidates)]),
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

export type PushResult = "session" | "cold" | "none";

/**
 * Deliver a journey prompt to whoever is driving this lead.
 *
 *   "session" — a chat exists; the prompt was sent, or parked behind a nudge
 *   "cold"    — no chat exists, so only the template went out. The customer's
 *               reply creates the session, and the button in the template (or
 *               their "hi") picks the journey up from there.
 *   "none"    — unreachable: no session, no usable phone, or no approved
 *               template. Caller should fall back to email/SMS/the dealer.
 *
 * Best-effort by contract. Callers hang this off the side of an already-
 * committed action (`void pushX(...).catch(() => {})`), so it must never throw
 * and must never be the reason a sanction or a doc request fails.
 */
export async function pushToLead(
  leadId: string,
  msg: { prompt: ParkedPrompt; nudge: NudgeSpec },
): Promise<PushResult> {
  try {
    const session = await bestLeadSession(leadId);
    if (session) {
      await sendOrPark(session, msg.prompt, msg.nudge);
      return "session";
    }
    return await pushCold(leadId, msg.nudge);
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
  leadId: string,
  nudge: NudgeSpec,
): Promise<PushResult> {
  const [lead] = await db
    .select({
      phone: leads.phone,
      mobile: leads.mobile,
      owner_contact: leads.owner_contact,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  const raw = lead?.phone || lead?.mobile || lead?.owner_contact || "";
  const waPhone = toWaPhone(raw);
  if (!waPhone) return "none";

  const tpl = resolveTemplate(nudge.template);
  if (!tpl) return "none";

  assertParamCount(nudge.template, nudge.params);
  const params = nudge.params.map((p) => oneLine(p));
  const res = await getAdapter().sendTemplate(
    waPhone,
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
