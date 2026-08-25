/**
 * E-264 Phase 2 — choosing the loan product over WhatsApp.
 *
 * THE GAP THIS CLOSES.
 *
 * When an admin approves Step 3, `applyKycFinalDecision` writes
 * kyc_status='step_3_cleared' and the dealer portal unlocks Section G. For a
 * lead that arrived over WhatsApp and has never seen the portal, that unlock is
 * invisible: the customer is told nothing, and the lead sits at step_3_cleared
 * until a dealer happens to open it. Phase 1 fixed the same shape for the
 * co-borrower; this is the next stop on the same journey.
 *
 * WHAT IT MUST NOT DO DIFFERENTLY FROM THE PORTAL.
 *
 * Two rules from Section G are load-bearing and are re-stated here rather than
 * re-derived:
 *
 *  1. **At most two LENDERS, one product each.** The cap counts distinct NBFCs,
 *     not products — an NBFC with four schemes is still one pick. Picking a
 *     second product from an already-chosen lender REPLACES that lender's
 *     product; it does not consume the second slot. Getting this wrong routes a
 *     customer to one lender twice and to the second lender never.
 *
 *  2. **The lender's real name is never shown.** The portal renders
 *     "iTarang Scheme N (NBFC-XXXX)" on purpose. Naming the NBFC in chat would
 *     leak commercial relationships to the customer over a channel they can
 *     forward, so the same masking applies here.
 *
 * The disclosure is not decoration either. Each picked lender independently
 * runs Field Investigation and Active Video KYC, and the ROI/tenure shown are
 * indicative bands, not an offer. `customer_disclosure_ack` records that the
 * customer was told so before the lead was routed — on this channel the
 * customer acknowledges it themselves, which is a stronger record than the
 * dealer's checkbox, not a weaker one.
 *
 * THE WRITE IS NOT REIMPLEMENTED. submitStep4ProductSelection() is the same
 * function POST /api/lead/[id]/submit-product-selection calls. A second copy of
 * the Acquire fan-out is exactly how a lead ends up submitted but invisible to
 * the lenders it was submitted to.
 */

import { eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { leads } from "@/lib/db/schema";
import {
  bajajFallbackMessage,
  recordNoPreferredPartner,
} from "@/lib/leads/bajaj-fallback";
import { loadSectionGOptions, type SectionGNbfc } from "@/lib/leads/section-g";
import {
  STEP4_UNLOCKED_STATUSES,
  submitStep4ProductSelection,
} from "@/lib/leads/submit-step4";

import type { ActiveDealer } from "./customer-lead";
import { leadActionId } from "./leadActionButton";
import { registerLeadAction } from "./leadActionReply";
import { pushToLead } from "./lead-push";
import { registerLeadState } from "./lead-states";
import type { ParkedPrompt } from "./outbound";
import {
  optionLabel,
  productLines,
  rowDescription,
  rowTitle,
} from "./scheme-format";
import { schemeName } from "./scheme-name";
import {
  patchLeadSub,
  reply,
  replyList,
  setSession,
  setSessionIf,
  type SessionRow,
} from "./session-store";
import type { InboundEvent, ListRow, ReplyButton } from "./types";
import { oneLine } from "./window";

/** Choosing a scheme from the matched list. */
export const DC_S4_PICK = "DC_S4_PICK";
/** One lender chosen; offering the optional second. */
export const DC_S4_MORE = "DC_S4_MORE";
/** Picks made; awaiting the customer's disclosure acknowledgement. */
export const DC_S4_ACK = "DC_S4_ACK";
/** Routed to the lenders; parked. */
export const DC_S4_WAIT = "DC_S4_WAIT";

/** Section G's cap, counted in distinct NBFCs. */
const MAX_LENDERS = 2;

/** Meta caps an interactive list at 10 rows in a single section. */
const MAX_ROWS = 10;

interface Pick {
  nbfcId: number;
  productId: number;
  /** What the customer saw when they chose it, for the confirmation message. */
  label: string;
}

interface S4Ctx {
  picks?: Pick[];
}

function s4Ctx(session: SessionRow): { leadId?: string; s4: S4Ctx } {
  const ctx = (session.context ?? {}) as {
    lead?: { leadId?: string; s4?: S4Ctx };
  };
  return { leadId: ctx.lead?.leadId, s4: ctx.lead?.s4 ?? {} };
}

function text(e: InboundEvent): string {
  return (e.text ?? "").trim();
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * The lenders and their products, as the customer reads them.
 *
 * Neither the lender NOR its product is named — see ./scheme-format for why the
 * product side matters just as much: printing `p.productName` ("Bajaj Finserv EV
 * Loan") identifies the lender exactly as well as its name would, and this
 * message is forwardable.
 *
 * The NBFC code is not printed either. It was, and it read as a bug to the
 * customer: an internal id in the middle of a price comparison.
 */
function detailBlock(opts: SectionGNbfc[]): string {
  return opts
    .map((o, i) => {
      const products = o.activeLoanProducts.map((p, j) => productLines(p, j));
      return `*${schemeName(i)}*\n${products.join("\n\n")}`;
    })
    .join("\n\n");
}

/**
 * One row per loan product, capped at Meta's ten.
 *
 * The cap is announced when it bites (see askPick) rather than silently
 * trimming: a customer who was shown 10 of 14 schemes and told nothing has been
 * quietly steered.
 */
function rowsFor(opts: SectionGNbfc[]): ListRow[] {
  const rows: ListRow[] = [];
  opts.forEach((o, i) => {
    o.activeLoanProducts.forEach((p, j) => {
      if (rows.length >= MAX_ROWS) return;
      rows.push({
        // Not a LEAD_ACTIONS prefix, so parseLeadAction leaves it alone and it
        // reaches this phase's state handler as ordinary text.
        id: `s4p:${o.nbfcId}:${p.id}`,
        // "Scheme 1 · Option A". The row used to be titled with the scheme
        // alone, so a lender offering two products produced two IDENTICAL rows
        // and the customer could not tell the offers apart.
        title: rowTitle(i, j),
        description: rowDescription(p),
      });
    });
  });
  return rows;
}

function parsePickRow(raw: string): { nbfcId: number; productId: number } | null {
  const m = raw.match(/^s4p:(\d{1,10}):(\d{1,10})$/);
  if (!m) return null;
  const nbfcId = Number(m[1]);
  const productId = Number(m[2]);
  if (!Number.isFinite(nbfcId) || !Number.isFinite(productId)) return null;
  return { nbfcId, productId };
}

const DISCLOSURE =
  "Before we send your application:\n\n" +
  "• Each lender you picked will verify you *independently* — that includes a " +
  "field visit and a short video KYC.\n" +
  "• The interest rate, tenure and down payment shown are *indicative ranges*. " +
  "Your final terms may differ.\n\n" +
  "Do you understand and agree?";

const ACK_BUTTONS: ReplyButton[] = [
  { id: "s4_agree", title: "✅ I agree" },
  { id: "s4_redo", title: "↩ Start over" },
];

const MORE_BUTTONS: ReplyButton[] = [
  { id: "s4_more_yes", title: "➕ Add a 2nd" },
  { id: "s4_more_no", title: "✅ Continue" },
];

// ---------------------------------------------------------------------------
// Entry: Step 3 was approved
// ---------------------------------------------------------------------------

/**
 * Tell the customer their financing options are open.
 *
 * Best-effort by contract — called with `void … .catch()` from
 * applyKycFinalDecision, which has already committed. A cash lead or a lead
 * whose status is not actually unlocked is a no-op rather than an error: the
 * caller fires this on every approval and does not want to know the rules.
 */
export async function pushStep4ToWhatsApp(leadId: string): Promise<void> {
  const [lead] = await db
    .select({
      reference_id: leads.reference_id,
      full_name: leads.full_name,
      owner_name: leads.owner_name,
      payment_method: leads.payment_method,
      kyc_status: leads.kyc_status,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  if (!lead) return;
  if (String(lead.payment_method || "").toLowerCase() !== "finance") return;
  if (!STEP4_UNLOCKED_STATUSES.has(String(lead.kyc_status))) return;

  const name = lead.full_name || lead.owner_name || "there";
  const ref = lead.reference_id || leadId;

  const prompt: ParkedPrompt = {
    kind: "text",
    body:
      `🎉 *Your KYC is approved!*\n\n` +
      `Hi ${name}, application ${ref} has cleared verification.\n\n` +
      `The next step is choosing who finances your battery. You can pick *one ` +
      `or two* lending partners — applying to two gives you a better chance of ` +
      `approval and lets you compare the offers that come back.\n\n` +
      `It takes about a minute.`,
    buttons: [
      { id: leadActionId("s4_start", leadId), title: "🏦 Choose lender" },
    ],
  };

  await pushToLead(leadId, {
    prompt,
    nudge: {
      template: "lead_action",
      params: [oneLine(name), oneLine(ref), "your financing options are ready"],
    },
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Load the matched lenders, minus any this session has already picked.
 *
 * Re-run on every turn rather than cached in the session context. The list is a
 * live BRE match against loan products an admin can deactivate at any moment,
 * and a stale cached option would submit the lead to a product that no longer
 * accepts it.
 */
async function optionsFor(
  leadId: string,
  exclude: number[] = [],
): Promise<{ options: SectionGNbfc[]; lead: typeof leads.$inferSelect } | null> {
  const [lead] = await db
    .select()
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return null;
  const all = await loadSectionGOptions(lead);
  return {
    lead,
    options: all.filter((o) => !exclude.includes(o.nbfcId)),
  };
}

/** `s4_start:<leadId>` */
async function onStep4Start(
  session: SessionRow,
  _event: InboundEvent,
  _dealer: ActiveDealer,
  leadId: string,
): Promise<void> {
  const loaded = await optionsFor(leadId);
  if (!loaded) return await lostTrack(session);
  const { lead, options } = loaded;

  if (String(lead.payment_method || "").toLowerCase() !== "finance") {
    await reply(
      session,
      "This application is a cash purchase — there's no financing to choose.",
    );
    return;
  }
  if (!STEP4_UNLOCKED_STATUSES.has(String(lead.kyc_status))) {
    // Already routed, or not approved yet. Say which, because the two are very
    // different pieces of news to a customer.
    await reply(
      session,
      lead.kyc_status === "pending_final_approval"
        ? "✅ Your application is already with the lenders — we'll message you here as soon as they respond."
        : "Your KYC verification isn't complete yet. We'll message you here the moment it is.",
    );
    return;
  }

  if (options.length === 0) {
    // No preferred partner covers this customer's state/city. That is not
    // "financing unavailable" — Bajaj Finserv operates nationally and can serve
    // them directly, so hand over the local Sales Manager rather than leaving
    // them with a dead end. The unserved city is recorded either way; a list of
    // the towns where customers asked and we had no partner is exactly what a
    // partnership team needs, and it only exists if we write it down now.
    await recordNoPreferredPartner({ leadId });
    await setSession(session.id, { current_state: DC_S4_WAIT });
    await reply(
      session,
      `${bajajFallbackMessage()}\n\n` +
        `_We've noted your details and the iTarang team will follow up if a ` +
        `partner becomes available in your area._`,
    );
    return;
  }

  await patchLeadSub(session.id, "s4", { picks: [] });
  await setSession(session.id, { current_state: DC_S4_PICK });
  await askPick(session, options, 0);
}

async function askPick(
  session: SessionRow,
  options: SectionGNbfc[],
  alreadyPicked: number,
): Promise<void> {
  const rows = rowsFor(options);
  const shownNbfcs = new Set(
    rows.map((r) => Number(r.id.split(":")[1])),
  ).size;

  const heading =
    alreadyPicked === 0
      ? "🏦 *Choose your lending partner*"
      : "🏦 *Choose a second lending partner*";

  const truncated =
    shownNbfcs < options.length
      ? `\n\n_Showing ${shownNbfcs} of ${options.length} partners. Reply *more* if none of these suit you._`
      : "";

  await replyList(
    session,
    `${heading}\n\n${detailBlock(options.slice(0, shownNbfcs))}${truncated}\n\n` +
      "Tap *Choose* below and pick a scheme.",
    "Choose",
    rows,
  );
}

/** DC_S4_PICK — a scheme was chosen, or something else arrived. */
async function onStep4Pick(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const { leadId, s4 } = s4Ctx(session);
  if (!leadId) return await lostTrack(session);

  const picks = s4.picks ?? [];
  const chosen = parsePickRow(text(event));

  if (!chosen) {
    const loaded = await optionsFor(
      leadId,
      picks.map((p) => p.nbfcId),
    );
    if (!loaded) return await lostTrack(session);
    await reply(
      session,
      "Please tap *Choose* on the message above and pick one of the schemes.",
    );
    await askPick(session, loaded.options, picks.length);
    return;
  }

  // Re-match rather than trusting the row: the list may have been sent minutes
  // ago and a product can be deactivated in between.
  const loaded = await optionsFor(leadId);
  if (!loaded) return await lostTrack(session);
  const nbfcIndex = loaded.options.findIndex((o) => o.nbfcId === chosen.nbfcId);
  const optionIndex =
    loaded.options[nbfcIndex]?.activeLoanProducts.findIndex(
      (p) => p.id === chosen.productId,
    ) ?? -1;
  const product = loaded.options[nbfcIndex]?.activeLoanProducts.find(
    (p) => p.id === chosen.productId,
  );
  if (!product) {
    await reply(
      session,
      "That scheme is no longer available. Here are the current options:",
    );
    await askPick(
      session,
      loaded.options.filter((o) => !picks.some((p) => p.nbfcId === o.nbfcId)),
      picks.length,
    );
    return;
  }

  // Masked on both halves. `product.productName` was rendered here — the second
  // place the lender's own brand reached a forwardable chat message.
  const label = `${schemeName(nbfcIndex)} · ${optionLabel(optionIndex)}`;

  // Section G rule 1: the cap counts LENDERS. A second product from a lender
  // already picked swaps that lender's product and leaves the count unchanged.
  const existing = picks.findIndex((p) => p.nbfcId === chosen.nbfcId);
  const next: Pick[] =
    existing >= 0
      ? picks.map((p, i) =>
          i === existing
            ? { nbfcId: chosen.nbfcId, productId: chosen.productId, label }
            : p,
        )
      : [
          ...picks,
          { nbfcId: chosen.nbfcId, productId: chosen.productId, label },
        ];

  await patchLeadSub(session.id, "s4", { picks: next });

  const remaining = loaded.options.filter(
    (o) => !next.some((p) => p.nbfcId === o.nbfcId),
  );

  if (next.length >= MAX_LENDERS || remaining.length === 0) {
    return await askDisclosure(session, next);
  }

  await setSession(session.id, { current_state: DC_S4_MORE });
  await reply(
    session,
    `✅ Selected: *${label}*\n\n` +
      "Would you like to apply to a *second* lender as well? Two applications " +
      "run in parallel, and you choose between whatever offers come back.",
    MORE_BUTTONS,
  );
}

/** DC_S4_MORE — the optional second lender. */
async function onStep4More(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const { leadId, s4 } = s4Ctx(session);
  if (!leadId) return await lostTrack(session);
  const picks = s4.picks ?? [];

  const t = text(event).toLowerCase();
  if (t === "s4_more_no" || t === "no" || t === "continue") {
    return await askDisclosure(session, picks);
  }
  if (t !== "s4_more_yes" && t !== "yes") {
    await reply(
      session,
      "Please tap *Add a 2nd* or *Continue*.",
      MORE_BUTTONS,
    );
    return;
  }

  const loaded = await optionsFor(
    leadId,
    picks.map((p) => p.nbfcId),
  );
  if (!loaded) return await lostTrack(session);
  if (loaded.options.length === 0) {
    await reply(
      session,
      "There's only one lending partner matched to your profile right now, so we'll go ahead with that one.",
    );
    return await askDisclosure(session, picks);
  }

  await setSession(session.id, { current_state: DC_S4_PICK });
  await askPick(session, loaded.options, picks.length);
}

async function askDisclosure(
  session: SessionRow,
  picks: Pick[],
): Promise<void> {
  if (picks.length === 0) {
    await reply(
      session,
      "Nothing is selected yet. Send *hi* and tap *Choose lender* to start again.",
    );
    await setSession(session.id, { current_state: "DC_MENU" });
    return;
  }

  await setSession(session.id, { current_state: DC_S4_ACK });
  await reply(
    session,
    `📋 *You've chosen:*\n${picks.map((p) => `• ${p.label}`).join("\n")}\n\n` +
      DISCLOSURE,
    ACK_BUTTONS,
  );
}

/** DC_S4_ACK — the disclosure, then the submit. */
async function onStep4Ack(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const { leadId, s4 } = s4Ctx(session);
  if (!leadId) return await lostTrack(session);
  const picks = s4.picks ?? [];

  const t = text(event).toLowerCase();

  if (t === "s4_redo" || t === "restart" || t === "start over") {
    const loaded = await optionsFor(leadId);
    if (!loaded) return await lostTrack(session);
    await patchLeadSub(session.id, "s4", { picks: [] });
    await setSession(session.id, { current_state: DC_S4_PICK });
    await askPick(session, loaded.options, 0);
    return;
  }

  if (t !== "s4_agree" && t !== "agree" && t !== "yes") {
    await reply(
      session,
      "Tap *I agree* to send your application, or *Start over* to change your selection.",
      ACK_BUTTONS,
    );
    return;
  }

  if (picks.length === 0) {
    return await askDisclosure(session, picks);
  }

  // Compare-and-swap BEFORE the write. WhatsApp buttons stay tappable after
  // they are pressed and a customer on a bad connection presses twice; two
  // submits would create two product_selections rows and two Acquire fan-outs.
  // Losing the race means someone else already claimed this turn — say nothing
  // more, the winner is mid-reply.
  const claimed = await setSessionIf(session.id, DC_S4_ACK, {
    current_state: DC_S4_WAIT,
  });
  if (!claimed) return;

  const [lead] = await db
    .select()
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return await lostTrack(session);

  if (!STEP4_UNLOCKED_STATUSES.has(String(lead.kyc_status))) {
    await reply(
      session,
      "✅ This application has already been sent to the lenders — we'll message you here as soon as they respond.",
    );
    return;
  }

  try {
    await submitStep4ProductSelection({
      leadId,
      lead,
      body: {
        selectedNbfcs: picks.map((p) => ({
          nbfc_id: String(p.nbfcId),
          loan_product_id: p.productId,
        })),
        // The customer acknowledged it themselves, on the record, one message
        // ago — a stronger attestation than the dealer's checkbox, not a weaker
        // one. See the module header.
        customerDisclosureAck: true,
      },
      submittedBy: lead.uploader_id ?? "",
      dealerCode: lead.dealer_id,
    });
  } catch (err) {
    console.error("[WhatsApp/step4] submit failed:", err);
    // Hand the turn back so a retry is possible — the CAS above already moved
    // the state, so put it back or the customer is stranded in DC_S4_WAIT.
    await setSession(session.id, { current_state: DC_S4_ACK });
    await reply(
      session,
      "Sorry — something went wrong sending your application. Please tap *I agree* once more.",
      ACK_BUTTONS,
    );
    return;
  }

  await reply(
    session,
    `🎉 *Application sent.*\n\n` +
      `Your application is now with:\n${picks.map((p) => `• ${p.label}`).join("\n")}\n\n` +
      "Each lender will verify you independently — expect a field visit and a " +
      "short video KYC. We'll message you here with their decision.",
  );
}

/** DC_S4_WAIT — parked. Anything sent here is an unprompted extra. */
async function onStep4Wait(session: SessionRow): Promise<void> {
  await reply(
    session,
    "Your application is with the lending partners — nothing more is needed " +
      "right now. We'll message you here as soon as there's a decision.",
  );
}

async function lostTrack(session: SessionRow): Promise<void> {
  await reply(
    session,
    "I've lost track of which application this is for. Please send *hi* to start again.",
  );
}

registerLeadAction("s4_start", onStep4Start);
registerLeadState(DC_S4_PICK, onStep4Pick);
registerLeadState(DC_S4_MORE, onStep4More);
registerLeadState(DC_S4_ACK, onStep4Ack);
registerLeadState(DC_S4_WAIT, onStep4Wait);
