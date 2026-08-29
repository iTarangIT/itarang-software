/**
 * E-264 Phase 3 / E-275 — financing offers and sanction, over WhatsApp.
 *
 * E-275 removed negotiation from the chat: the customer accepts the lender's
 * offer or waits. `pushOfferFixedToWhatsApp` stays exported for callers that
 * still reference it but is no longer wired to a negotiation loop.
 *
 * This is the half of the journey that was missing. Step 4 ended at "sent to
 * your lenders" and the next thing the customer heard was "your loan is
 * sanctioned" — everything in between (what was offered, asking for better
 * terms, the lender's answer, choosing one) happened only in the dealer portal.
 *
 * WHAT BELONGS IN CHAT HERE, AND WHAT DOES NOT.
 *
 * A borrower comparing at most two offers is reading six numbers each. That fits
 * a message. Deciding between them is a pick-one, which is a list row. Asking
 * for a better rate is a sentence, which is a text turn. All three are native.
 *
 * The lender does NOT negotiate here — it prices from its own portal, where its
 * credit officer has the bureau pull, the deviation rules and the CEO gate in
 * front of them. Chat carries the ask up and the answer back; it never carries
 * the underwriting.
 *
 * THREE RULES THIS MODULE EXISTS TO NOT BREAK.
 *
 * 1. The lender is never named. See ./scheme-name — and note that the label must
 *    come from `schemeLabelsForLead`, not a fresh positional index, or "Scheme 2"
 *    in an offer can be a different lender from the "Scheme 2" the customer
 *    picked at Step 4.
 *
 * 2. A CEO-held offer never reaches the borrower. That filter lives once, in
 *    `listLeadOffers`; this module reads through it and never queries
 *    `nbfc_financing_offers` directly.
 *
 * 3. There is no "ask for better" in chat (E-275). The only action on an offer
 *    is to accept it.
 */

import { eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { leads } from "@/lib/db/schema";
import {
  actionableOffers,
  listLeadOffers,
  type LeadOfferItem,
} from "@/lib/leads/offers";
import { OfferActionError } from "@/lib/leads/negotiate-offer";
import { selectOfferWinner } from "@/lib/leads/select-winner";

import type { ActiveDealer } from "./customer-lead";
import { leadActionId } from "./leadActionButton";
import { registerLeadAction } from "./leadActionReply";
import { pushToLead } from "./lead-push";
import { registerLeadState } from "./lead-states";
import { labelFor, schemeLabelsForLead } from "./scheme-name";
import {
  patchLeadSub,
  reply,
  replyList,
  setSession,
  setSessionIf,
  type SessionRow,
} from "./session-store";
import type { InboundEvent, ListRow } from "./types";
import { oneLine } from "./window";

export const DC_OF_VIEW = "DC_OF_VIEW";
export const DC_OF_WAIT = "DC_OF_WAIT";

/** Meta's hard cap on interactive list rows. */
const MAX_ROWS = 10;

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const inr = (v: string | number | null | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) ? `₹${n.toLocaleString("en-IN")}` : "—";
};

/** The six numbers, as a borrower reads them. */
function termsBlock(item: LeadOfferItem, label: string): string {
  const o = item.offer!;
  const fixed = item.negotiation_status === "fixed" ? "  _(final terms)_" : "";
  return (
    `*${label}*${fixed}\n` +
    `   Loan ${inr(o.loan_amount)} · ROI ${o.roi_pct ?? "—"}%\n` +
    `   EMI ${inr(o.emi_amount)} × ${o.tenure_months ?? "—"} months\n` +
    `   Down payment ${inr(o.down_payment)} · Processing fee ${inr(o.processing_fee)}`
  );
}

/**
 * The lender's own last words on the thread, if any.
 *
 * This is what makes the loop feel like a conversation rather than a price
 * ticker: the customer asked for something in their own words, and the reply
 * that comes back is the lender's, not a status change.
 */
function lastLenderMessage(item: LeadOfferItem): string | null {
  for (let i = item.negotiation.length - 1; i >= 0; i -= 1) {
    const r = item.negotiation[i];
    if (r.party === "nbfc" && r.message && r.message.trim()) {
      return r.message.trim();
    }
  }
  return null;
}

function rowsFor(items: LeadOfferItem[], labels: Map<number, string>): ListRow[] {
  const rows: ListRow[] = [];
  items.forEach((item, i) => {
    const label = labelFor(labels, item.nbfc_id, i);
    if (rows.length < MAX_ROWS) {
      rows.push({
        // Not a LEAD_ACTIONS prefix, so parseLeadAction leaves it alone and it
        // reaches this phase's state handler as ordinary text — the same
        // convention step4-flow uses for `s4p:`.
        id: `ofp:${item.nbfc_id}`,
        title: `✅ Accept ${label}`.slice(0, 24),
        description: `EMI ${inr(item.offer!.emi_amount)} × ${item.offer!.tenure_months ?? "—"} months`.slice(0, 72),
      });
    }
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Entry: a lender has priced (or re-priced) the loan
// ---------------------------------------------------------------------------

/**
 * A lender submitted or resubmitted its offer — tell the borrower.
 *
 * Called from the NBFC offer route, best-effort: the offer is already committed
 * and must not be undone by a messaging failure. Deliberately silent when the
 * offer is not released (E-161) — `listLeadOffers` filters it out and there is
 * nothing to say until the iTarang CEO decides.
 */
export async function pushOfferToWhatsApp(
  leadId: string,
  nbfcId: number,
): Promise<void> {
  const view = await listLeadOffers(leadId);
  const item = view.items.find((i) => i.nbfc_id === nbfcId);
  if (!item?.offer) return;

  const labels = await schemeLabelsForLead(leadId);
  const label = labelFor(labels, nbfcId, view.items.indexOf(item));
  // A resubmit after the customer countered is an ANSWER, and should read like
  // one — otherwise the second offer looks like an unrelated new one.
  const answered = item.negotiation.some((r) => r.party === "customer");
  const note = lastLenderMessage(item);

  await pushToLead(leadId, (t) => {
    const dealerSide = t.audience === "dealer";
    const head = answered
      ? dealerSide
        ? `💬 *${label} has replied on ${t.customerName}'s request*`
        : `💬 *${label} has replied to your request*`
      : dealerSide
        ? `💰 *${label} has made an offer for ${t.customerName}*`
        : `💰 *${label} has made you an offer*`;

    return {
      prompt: {
        kind: "text",
        body:
          `${head}\n\n${termsBlock(item, label)}` +
          (note ? `\n\n_"${note}"_` : "") +
          (dealerSide
            ? `\n\nTap below to see the offer on this application and accept it.`
            : `\n\nTap below to see your offer and accept it.`),
        buttons: [{ id: leadActionId("of_view", leadId), title: "📋 View offers" }],
      },
      nudge: {
        template: "lead_action",
        params: [
          oneLine(t.greetName),
          oneLine(t.referenceId),
          dealerSide
            ? `${t.customerName} has a financing offer`
            : "you have a financing offer",
        ],
      },
    };
  });
}

/**
 * A lender fixed its terms — no more negotiation on that offer.
 *
 * Separate from the push above because the message has to say the door has
 * closed. A customer who keeps being told "ask for better" after the lender
 * fixed will keep asking, and keep being refused.
 */
export async function pushOfferFixedToWhatsApp(
  leadId: string,
  nbfcId: number,
): Promise<void> {
  const view = await listLeadOffers(leadId);
  const item = view.items.find((i) => i.nbfc_id === nbfcId);
  if (!item?.offer) return;

  const labels = await schemeLabelsForLead(leadId);
  const label = labelFor(labels, nbfcId, view.items.indexOf(item));
  await pushToLead(leadId, (t) => {
    const dealerSide = t.audience === "dealer";
    return {
      prompt: {
        kind: "text",
        body:
          (dealerSide
            ? `🔒 *${label} has confirmed its final terms for ${t.customerName}*`
            : `🔒 *${label} has confirmed its final terms*`) +
          `\n\n${termsBlock(item, label)}\n\n` +
          `These terms will not change further. Tap below to accept, or to compare ` +
          (dealerSide ? `with the other lender.` : `with your other lender.`),
        buttons: [{ id: leadActionId("of_view", leadId), title: "📋 View offers" }],
      },
      nudge: {
        template: "lead_action",
        params: [
          oneLine(t.greetName),
          oneLine(t.referenceId),
          "a lender confirmed its final terms",
        ],
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** `of_view:<leadId>` — render every live offer and the actions on it. */
async function onOfferView(
  session: SessionRow,
  _event: InboundEvent,
  _dealer: ActiveDealer,
  leadId: string,
): Promise<void> {
  await showOffers(session, leadId);
}

/**
 * Re-read and render. Called on every entry rather than cached, because an offer
 * can be fixed, withdrawn or re-priced between two of the customer's turns —
 * rendering a stale copy would show terms nobody is standing behind.
 */
async function showOffers(session: SessionRow, leadId: string): Promise<void> {
  const view = await listLeadOffers(leadId);

  if (view.winnerNbfcId != null) {
    await setSession(session.id, { current_state: DC_OF_WAIT });
    await reply(
      session,
      "✅ You've already chosen your lender. They're completing the final checks — " +
        "we'll message you here as soon as your loan is approved.",
    );
    return;
  }

  const live = actionableOffers(view);
  if (live.length === 0) {
    await setSession(session.id, { current_state: DC_OF_WAIT });
    // Distinguish "held for review" from "nobody has priced yet": they wait on
    // different people, and telling the customer the wrong one invites them to
    // chase the wrong party.
    const held = view.items.some((i) => i.withheld_reason === "pending");
    await reply(
      session,
      held
        ? "⏳ Your lender's terms are with the iTarang credit team for a final check. " +
            "We'll message you here as soon as they're released."
        : "⏳ Your lenders are still reviewing your application. We'll message you " +
            "here the moment there's an offer.",
    );
    return;
  }

  const labels = await schemeLabelsForLead(leadId);
  const blocks = live.map((item, i) =>
    termsBlock(item, labelFor(labels, item.nbfc_id, i)),
  );

  await setSession(session.id, { current_state: DC_OF_VIEW });
  await patchLeadSub(session.id, "of", {
    offers: live.map((item, i) => ({
      nbfcId: item.nbfc_id,
      name: labelFor(labels, item.nbfc_id, i),
      emi: String(item.offer!.emi_amount ?? ""),
      tenure: Number(item.offer!.tenure_months ?? 0),
      roi: String(item.offer!.roi_pct ?? ""),
      loanAmount: String(item.offer!.loan_amount ?? ""),
    })),
  });

  await replyList(
    session,
    `📋 *Your financing offer${live.length > 1 ? "s" : ""}*\n\n${blocks.join("\n\n")}\n\n` +
      `Tap *Choose* and accept to go ahead.`,
    "Choose",
    rowsFor(live, labels),
  );
}

/** DC_OF_VIEW — a tapped row, or anything else. */
async function onOfferChoice(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const leadId = leadIdOf(session);
  if (!leadId) {
    await reply(session, "I've lost track of this application. Please send *hi* to start again.");
    return;
  }

  const raw = (event.text ?? "").trim();
  const pick = raw.match(/^ofp:(\d{1,10})$/);

  if (pick) {
    await acceptOffer(session, leadId, Number(pick[1]));
    return;
  }

  // Not a row we recognise — re-render rather than guess. The list may have
  // scrolled out of the customer's view, and a bare "?" helps nobody.
  await showOffers(session, leadId);
}

/**
 * Accept one lender's standing offer.
 *
 * Guarded with a compare-and-swap on the state so a double-tapped row cannot run
 * the winner selection twice — the same protection step4-flow puts on its submit.
 */
async function acceptOffer(
  session: SessionRow,
  leadId: string,
  nbfcId: number,
): Promise<void> {
  const moved = await setSessionIf(session.id, DC_OF_VIEW, {
    current_state: DC_OF_WAIT,
  });
  if (!moved) {
    await reply(session, "That's already being processed — one moment.");
    return;
  }

  try {
    await selectOfferWinner({ leadId, nbfcId });
  } catch (err) {
    // Put the customer back where they were so they can choose again.
    await setSession(session.id, { current_state: DC_OF_VIEW });
    if (err instanceof OfferActionError) {
      await reply(session, `⚠️ ${err.message}`);
      await showOffers(session, leadId);
      return;
    }
    throw err;
  }

  const labels = await schemeLabelsForLead(leadId);
  await patchLeadSub(session.id, "of", { pickedNbfcId: nbfcId });
  await reply(
    session,
    `🎉 *You've chosen ${labelFor(labels, nbfcId, 0)}.*\n\n` +
      `They'll now complete the final checks — a field visit, a short video KYC ` +
      `and your EMI mandate.\n\n` +
      `We'll message you here the moment your loan is approved, and then you can ` +
      `choose your battery.`,
  );
}

/** `of_pick:<leadId>:<nbfcId>` — accept straight from a pushed button. */
async function onOfferPick(
  session: SessionRow,
  _event: InboundEvent,
  _dealer: ActiveDealer,
  leadId: string,
  arg?: string,
): Promise<void> {
  const nbfcId = Number(arg);
  if (!Number.isInteger(nbfcId) || nbfcId <= 0) {
    await showOffers(session, leadId);
    return;
  }
  // The button arrives from outside a turn, so the state guard in acceptOffer
  // has nothing to compare against yet. Put us in DC_OF_VIEW first so the
  // double-tap protection still applies.
  await setSession(session.id, { current_state: DC_OF_VIEW });
  await acceptOffer({ ...session, current_state: DC_OF_VIEW }, leadId, nbfcId);
}

/** DC_OF_WAIT — parked between the customer's move and the lender's. */
async function onOfferWait(session: SessionRow): Promise<void> {
  const leadId = leadIdOf(session);
  if (!leadId) {
    await reply(session, "Please send *hi* to see your options.");
    return;
  }

  const [lead] = await db
    .select({ kyc_status: leads.kyc_status })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  if (lead?.kyc_status === "loan_sanctioned") {
    await reply(
      session,
      "🎉 Your loan is sanctioned! Send *hi* and choose your application to arrange delivery.",
    );
    return;
  }

  // An offer may have landed while they were parked — show it rather than
  // telling someone with a fresh offer that there is nothing to do.
  const view = await listLeadOffers(leadId);
  if (view.winnerNbfcId == null && actionableOffers(view).length > 0) {
    await showOffers(session, leadId);
    return;
  }

  await reply(
    session,
    "Nothing more is needed from you right now — we'll message you here as soon " +
      "as there's an update on your application.",
  );
}

// ---------------------------------------------------------------------------
// Sanction
// ---------------------------------------------------------------------------

/**
 * The loan is sanctioned.
 *
 * The dispatch phase owns the "arrange delivery" prompt; this exists so the news
 * itself rides the dedicated `sanctioned` template rather than the generic
 * doorbell, which is what the template was approved for.
 */
export async function pushSanctionedToWhatsApp(
  leadId: string,
  amount?: string | null,
  emi?: string | null,
): Promise<void> {
  await pushToLead(leadId, (t) => {
    const dealerSide = t.audience === "dealer";
    return {
      prompt: {
        kind: "text",
        body:
          (dealerSide
            ? `🎉 *Loan approved for ${t.customerName}!*\n\n${t.greetName}, application ${t.referenceId} has been sanctioned`
            : `🎉 *Your loan is approved!*\n\n${t.greetName}, application ${t.referenceId} has been sanctioned`) +
          (amount ? ` for ${inr(amount)}` : "") +
          (emi ? ` — EMI ${inr(emi)}` : "") +
          (dealerSide
            ? `.\n\nNext: choose the battery and arrange delivery.`
            : `.\n\nNext: choose your battery and arrange delivery.`),
        buttons: [{ id: leadActionId("sn_ack", leadId), title: "📦 Continue" }],
      },
      nudge: {
        template: "sanctioned",
        params: [
          oneLine(t.greetName),
          oneLine(t.referenceId),
          oneLine(amount ? inr(amount) : "—"),
        ],
      },
    };
  });
}

/**
 * `sn_ack:<leadId>` — hand straight over to the dispatch phase.
 *
 * Imported lazily so this module and dispatch-flow can each be loaded on their
 * own; lead-phases imports both, and a static edge between them would make the
 * registration order matter.
 */
async function onSanctionAck(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
  leadId: string,
): Promise<void> {
  const { startDispatch } = await import("./dispatch-flow");
  await startDispatch(session, event, dealer, leadId);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function leadIdOf(session: SessionRow): string | undefined {
  const ctx = (session.context ?? {}) as { lead?: { leadId?: string } };
  return ctx.lead?.leadId;
}

registerLeadAction("of_view", onOfferView);
registerLeadAction("of_pick", onOfferPick);
registerLeadAction("sn_ack", onSanctionAck);
registerLeadState(DC_OF_VIEW, onOfferChoice, { rerenderOnGreeting: true });
registerLeadState(DC_OF_WAIT, onOfferWait, { rerenderOnGreeting: true });
