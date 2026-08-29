/**
 * E-264 Phase 2 / E-275 — choosing the loan product over WhatsApp.
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
 * Rules from Section G that are load-bearing and re-stated here rather than
 * re-derived:
 *
 *  1. **ONE lender** (E-275; was two). A file sits with exactly one NBFC at a
 *     time. Another lender can be chosen only after that one rejects — the
 *     `s4_again` button below — and that goes through `reselectFinancing`, the
 *     same rules the web card binds.
 *
 *  2. **The lender's real name is never shown.** The portal renders
 *     "iTarang Scheme N" on purpose. Naming the NBFC in chat would leak
 *     commercial relationships to the customer over a channel they can
 *     forward, so the same masking applies here.
 *
 *  3. **The loan amount is asked first** (E-275). `leads.requested_loan_amount`
 *     feeds the BRE so a customer is never shown a product whose ceiling is
 *     below what they asked for.
 *
 *  4. **No partner in the area is not a dead end.** Bajaj Finance operates
 *     nationally; taking that card sanctions the lead on the spot (no NBFC, no
 *     admin gate) and the chat rolls straight into Step 5 — cart, margin,
 *     customer card, OTP — in the same conversation.
 *
 * THE WRITE IS NOT REIMPLEMENTED. submitStep4ProductSelection() is the same
 * function POST /api/lead/[id]/submit-product-selection calls, and
 * reselectFinancing() the same one POST /api/lead/[id]/reselect-financing
 * calls. A second copy of the Acquire fan-out is exactly how a lead ends up
 * submitted but invisible to the lender it was submitted to.
 */

import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { leads, nbfcLeadAssignments } from "@/lib/db/schema";
import {
  BAJAJ_EXTERNAL_LENDER,
  BAJAJ_FALLBACK,
  NBFC_RECEIVED_MSG,
  bajajFallbackMessage,
  recordNoPreferredPartner,
  type ExternalLenderId,
} from "@/lib/leads/bajaj-fallback";
import { loadSectionGOptions, type SectionGNbfc } from "@/lib/leads/section-g";
import { getPreSanctionBucket } from "@/lib/leads/pre-sanction-bucket";
import {
  formatRupees,
  parseRupees,
  setRequestedLoanAmount,
} from "@/lib/leads/requested-loan-amount";
import { ReselectError, reselectFinancing } from "@/lib/leads/reselect-financing";
import {
  STEP4_UNLOCKED_STATUSES,
  submitStep4ProductSelection,
} from "@/lib/leads/submit-step4";

import type { ActiveDealer } from "./customer-lead";
import { startDispatch } from "./dispatch-flow";
import { leadActionId } from "./leadActionButton";
import { registerLeadAction } from "./leadActionReply";
import { pushToLead } from "./lead-push";
import { registerLeadState } from "./lead-states";
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

/** "Up to how much loan do you want?" */
export const DC_S4_AMT = "DC_S4_AMT";
/** Choosing a scheme from the matched list. */
export const DC_S4_PICK = "DC_S4_PICK";
/** No partner in the area — the Bajaj Finance card. */
export const DC_S4_BAJAJ = "DC_S4_BAJAJ";
/** Pick made; awaiting the customer's disclosure acknowledgement. */
export const DC_S4_ACK = "DC_S4_ACK";
/** Routed to the lender; parked. */
export const DC_S4_WAIT = "DC_S4_WAIT";

/** Section G's cap, counted in distinct NBFCs. E-275: one. */
export const MAX_LENDERS = 1;

/** Meta caps an interactive list at 10 rows in a single section. */
const MAX_ROWS = 10;

interface Pick {
  nbfcId: number;
  productId: number;
  /** What the customer saw when they chose it, for the confirmation message. */
  label: string;
}

/**
 * `submit`   — first routing, via submitStep4ProductSelection.
 * `reselect` — after an NBFC rejection, via reselectFinancing.
 */
type S4Mode = "submit" | "reselect";

interface S4Ctx {
  picks?: Pick[];
  mode?: S4Mode;
  /** Set when the Bajaj card was taken; the submit carries it instead of picks. */
  externalLender?: ExternalLenderId;
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
 * product side matters just as much: printing `p.productName` ("<Lender> EV
 * Loan") identifies the lender exactly as well as its name would, and this
 * message is forwardable.
 */
function detailBlock(opts: SectionGNbfc[]): string {
  return opts
    .map((o, i) => {
      const products = o.activeLoanProducts.map((p, j) => productLines(p, j));
      return `*${schemeName(i)}*\n${products.join("\n\n")}`;
    })
    .join("\n\n");
}

/** One row per loan product, capped at Meta's ten. */
function rowsFor(opts: SectionGNbfc[]): ListRow[] {
  const rows: ListRow[] = [];
  opts.forEach((o, i) => {
    o.activeLoanProducts.forEach((p, j) => {
      if (rows.length >= MAX_ROWS) return;
      rows.push({
        // Not a LEAD_ACTIONS prefix, so parseLeadAction leaves it alone and it
        // reaches this phase's state handler as ordinary text.
        id: `s4p:${o.nbfcId}:${p.id}`,
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

const AMOUNT_PROMPT =
  "💰 *Up to how much loan do you want?*\n\n" +
  "Reply with an amount, e.g. 60000 or 1.5 lakh.";

const DISCLOSURE =
  "Before we send your application:\n\n" +
  "• The lender will verify you *independently* before making an offer.\n" +
  "• The interest rate, tenure and down payment shown are *indicative ranges*. " +
  "Your final terms may differ.\n\n" +
  "Do you understand and agree?";

const ACK_BUTTONS: ReplyButton[] = [
  { id: "s4_agree", title: "✅ I agree" },
  { id: "s4_redo", title: "↩ Start over" },
];

const BAJAJ_BUTTONS: ReplyButton[] = [
  { id: "s4b_go", title: "✅ Continue with Bajaj" },
  { id: "s4_redo", title: "↩ Back" },
];

/** "Application sent" — the one wording, for both the first pick and a re-pick. */
function sentMessage(labels: string[]): string {
  return (
    `🎉 *Application sent.*\n\n` +
    `Your application is now with:\n${labels.map((l) => `• ${l}`).join("\n")}\n\n` +
    NBFC_RECEIVED_MSG
  );
}

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
      payment_method: leads.payment_method,
      kyc_status: leads.kyc_status,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  if (!lead) return;
  if (String(lead.payment_method || "").toLowerCase() !== "finance") return;
  if (!STEP4_UNLOCKED_STATUSES.has(String(lead.kyc_status))) return;

  await pushToLead(leadId, (t) => {
    const dealerSide = t.audience === "dealer";
    return {
      prompt: {
        kind: "text",
        body:
          (dealerSide
            ? `🎉 *${t.customerName}'s KYC is approved!*\n\n` +
              `Hi ${t.greetName}, application ${t.referenceId} has cleared verification.\n\n` +
              `The next step is choosing who finances the battery. Pick one lending partner.\n\n`
            : `🎉 *Your KYC is approved!*\n\n` +
              `Hi ${t.greetName}, application ${t.referenceId} has cleared verification.\n\n` +
              `The next step is choosing who finances your battery. Pick one lending partner.\n\n`) +
          `It takes about a minute.`,
        buttons: [
          { id: leadActionId("s4_start", leadId), title: "🏦 Choose lender" },
        ],
      },
      nudge: {
        template: "lead_action",
        params: [
          oneLine(t.greetName),
          oneLine(t.referenceId),
          dealerSide
            ? `${t.customerName}'s financing options are ready`
            : "your financing options are ready",
        ],
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Entry: an NBFC rejected the file (E-275)
// ---------------------------------------------------------------------------

async function rejectionBody(
  leadId: string,
  nbfcName: string,
  note: string,
): Promise<string | null> {
  const [lead] = await db
    .select({
      full_name: leads.full_name,
      owner_name: leads.owner_name,
      mobile: leads.mobile,
      phone: leads.phone,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return null;
  const name = lead.full_name || lead.owner_name || "Customer";
  const mobile = lead.mobile || lead.phone || "—";
  return (
    `❌ *${nbfcName} rejected the file*\n\n` +
    `File: ${name} · ${mobile}\n` +
    `Reason: ${note.trim() || "—"}\n\n` +
    `You can choose another lender for this customer.`
  );
}

function rejectionButtons(leadId: string): ReplyButton[] {
  return [{ id: leadActionId("s4_again", leadId), title: "🏦 Choose another NBFC" }];
}

/**
 * The admin forwarded an NBFC's rejection to the dealer. Lands in the OWNING
 * DEALER's chat (`pushToLead` resolves the dealer channel first). The lender
 * IS named here — this message goes to the dealer, who already knows which
 * NBFC they routed to, and the reason is theirs to act on.
 *
 * Called via dynamic import from the admin route; keep the signature stable.
 */
export async function pushRejectionToWhatsApp(
  leadId: string,
  opts: { nbfcName: string; note: string },
): Promise<void> {
  const body = await rejectionBody(leadId, opts.nbfcName, opts.note);
  if (!body) return;
  await pushToLead(leadId, (t) => ({
    prompt: { kind: "text", body, buttons: rejectionButtons(leadId) },
    nudge: {
      template: "lead_action",
      params: [
        oneLine(t.greetName),
        oneLine(t.referenceId),
        `${opts.nbfcName} rejected ${t.customerName}'s file`,
      ],
    },
  }));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Load the matched lenders, minus any this lead already has an assignment
 * with. Re-run on every turn rather than cached: the list is a live BRE match
 * against loan products an admin can deactivate at any moment, and a stale
 * cached option would submit the lead to a product that no longer accepts it.
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
  const all = await loadSectionGOptions(lead, lead.requested_loan_amount ?? null);
  return {
    lead,
    options: all.filter((o) => !exclude.includes(o.nbfcId)),
  };
}

/** Every NBFC ever on this lead, in any status — never offered again. */
async function assignedNbfcIds(leadId: string): Promise<number[]> {
  const rows = await db
    .select({ nbfc_id: nbfcLeadAssignments.nbfc_id })
    .from(nbfcLeadAssignments)
    .where(eq(nbfcLeadAssignments.lead_id, leadId));
  return rows.map((r) => r.nbfc_id);
}

/** The lead's newest assignment, for the wait-state's "was it rejected?" check. */
async function latestAssignment(leadId: string) {
  const [row] = await db
    .select({
      status: nbfcLeadAssignments.status,
      rejection_note: nbfcLeadAssignments.rejection_note,
      rejection_forwarded_at: nbfcLeadAssignments.rejection_forwarded_at,
      nbfc_id: nbfcLeadAssignments.nbfc_id,
    })
    .from(nbfcLeadAssignments)
    .where(eq(nbfcLeadAssignments.lead_id, leadId))
    .orderBy(desc(nbfcLeadAssignments.updated_at))
    .limit(1);
  return row ?? null;
}

async function nbfcDisplayName(nbfcId: number): Promise<string> {
  const { nbfc } = await import("@/lib/db/schema");
  const [row] = await db
    .select({ name: nbfc.legal_name })
    .from(nbfc)
    .where(eq(nbfc.id, nbfcId))
    .limit(1);
  return row?.name || "The lender";
}

/** `s4_start:<leadId>` */
async function onStep4Start(
  session: SessionRow,
  _event: InboundEvent,
  _dealer: ActiveDealer,
  leadId: string,
): Promise<void> {
  const [lead] = await db
    .select({
      payment_method: leads.payment_method,
      kyc_status: leads.kyc_status,
      requested_loan_amount: leads.requested_loan_amount,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return await lostTrack(session);

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
        ? "✅ Your application is already with the lender — we'll message you here as soon as they respond."
        : "Your KYC verification isn't complete yet. We'll message you here the moment it is.",
    );
    return;
  }

  await patchLeadSub(session.id, "s4", {
    picks: [],
    mode: "submit",
    externalLender: null,
  });

  if (lead.requested_loan_amount == null) {
    return await askAmount(session);
  }
  await showLenders(session, leadId, "submit");
}

/**
 * `s4_again:<leadId>` — E-275, after an NBFC rejection. Same picker, but the
 * pick binds through `reselectFinancing` and every NBFC already on the lead
 * is left off the list.
 */
async function onStep4Again(
  session: SessionRow,
  _event: InboundEvent,
  _dealer: ActiveDealer,
  leadId: string,
): Promise<void> {
  const [lead] = await db
    .select({
      payment_method: leads.payment_method,
      requested_loan_amount: leads.requested_loan_amount,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return await lostTrack(session);
  if (String(lead.payment_method || "").toLowerCase() !== "finance") {
    await reply(
      session,
      "This application is a cash purchase — there's no lender to choose.",
    );
    return;
  }

  await patchLeadSub(session.id, "s4", {
    picks: [],
    mode: "reselect",
    externalLender: null,
  });

  if (lead.requested_loan_amount == null) {
    return await askAmount(session);
  }
  await showLenders(session, leadId, "reselect");
}

async function askAmount(session: SessionRow): Promise<void> {
  await setSession(session.id, { current_state: DC_S4_AMT });
  await reply(session, AMOUNT_PROMPT);
}

/** DC_S4_AMT — the requested loan amount. */
async function onStep4Amount(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const { leadId, s4 } = s4Ctx(session);
  if (!leadId) return await lostTrack(session);

  const amount = parseRupees(text(event));
  if (amount == null) {
    await reply(
      session,
      "I couldn't read that as an amount. " + AMOUNT_PROMPT,
    );
    return;
  }

  const ok = await setRequestedLoanAmount(leadId, amount);
  if (!ok) return await lostTrack(session);

  await reply(session, `✅ Loan amount noted: *${formatRupees(amount)}*.`);
  await showLenders(session, leadId, s4.mode ?? "submit");
}

/**
 * The lender list, or the Bajaj card when nobody covers this customer.
 *
 * In `reselect` mode the NBFCs already on the lead are excluded up front — the
 * UNIQUE(lead_id, nbfc_id) rule in reselectFinancing would refuse them anyway,
 * but a customer should not be shown a lender they cannot pick.
 */
async function showLenders(
  session: SessionRow,
  leadId: string,
  mode: S4Mode,
): Promise<void> {
  const exclude = mode === "reselect" ? await assignedNbfcIds(leadId) : [];
  const loaded = await optionsFor(leadId, exclude);
  if (!loaded) return await lostTrack(session);

  if (loaded.options.length === 0) {
    // No preferred partner covers this customer's state/city (or none is
    // left). That is not "financing unavailable" — Bajaj Finance operates
    // nationally and can serve them directly. Taking the card sanctions the
    // lead on the spot and moves straight to delivery. The unserved city is
    // recorded either way; a list of the towns where customers asked and we
    // had no partner is exactly what a partnership team needs, and it only
    // exists if we write it down now.
    await recordNoPreferredPartner({ leadId });
    await setSession(session.id, { current_state: DC_S4_BAJAJ });
    await reply(
      session,
      `${bajajFallbackMessage()}\n\n` +
        `You can continue with ${BAJAJ_FALLBACK.name} and arrange delivery now.`,
      BAJAJ_BUTTONS,
    );
    return;
  }

  await setSession(session.id, { current_state: DC_S4_PICK });
  await askPick(session, loaded.options);
}

async function askPick(
  session: SessionRow,
  options: SectionGNbfc[],
): Promise<void> {
  const rows = rowsFor(options);
  const shownNbfcs = new Set(
    rows.map((r) => Number(r.id.split(":")[1])),
  ).size;

  const truncated =
    shownNbfcs < options.length
      ? `\n\n_Showing ${shownNbfcs} of ${options.length} partners._`
      : "";

  await replyList(
    session,
    `🏦 *Choose your lending partner*\n\n${detailBlock(options.slice(0, shownNbfcs))}${truncated}\n\n` +
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
  const mode = s4.mode ?? "submit";

  const chosen = parsePickRow(text(event));
  const exclude = mode === "reselect" ? await assignedNbfcIds(leadId) : [];

  // Re-match rather than trusting the row: the list may have been sent minutes
  // ago and a product can be deactivated in between.
  const loaded = await optionsFor(leadId, exclude);
  if (!loaded) return await lostTrack(session);

  if (!chosen) {
    await reply(
      session,
      "Please tap *Choose* on the message above and pick one of the schemes.",
    );
    if (loaded.options.length === 0) return await showLenders(session, leadId, mode);
    await askPick(session, loaded.options);
    return;
  }

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
    return await showLenders(session, leadId, mode);
  }

  // Masked on both halves — see the module header.
  const label = `${schemeName(nbfcIndex)} · ${optionLabel(optionIndex)}`;
  const picks: Pick[] = [
    { nbfcId: chosen.nbfcId, productId: chosen.productId, label },
  ];
  await patchLeadSub(session.id, "s4", { picks, externalLender: null });
  return await askDisclosure(session, [label]);
}

/** DC_S4_BAJAJ — the card for an area with no partner. */
async function onStep4Bajaj(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const { leadId } = s4Ctx(session);
  if (!leadId) return await lostTrack(session);

  const t = text(event).toLowerCase();
  if (t === "s4_redo" || t === "back") {
    // "Back" to the one thing they can change: the amount. A different ceiling
    // can bring a partner into range.
    return await askAmount(session);
  }
  if (t !== "s4b_go" && t !== "continue" && t !== "yes") {
    await reply(
      session,
      `Tap *Continue with Bajaj* to go ahead with ${BAJAJ_FALLBACK.name}, or *Back*.`,
      BAJAJ_BUTTONS,
    );
    return;
  }

  await patchLeadSub(session.id, "s4", {
    picks: [],
    externalLender: BAJAJ_EXTERNAL_LENDER,
  });
  await askDisclosure(session, [BAJAJ_FALLBACK.name]);
}

async function askDisclosure(
  session: SessionRow,
  labels: string[],
): Promise<void> {
  if (labels.length === 0) {
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
    `📋 *You've chosen:*\n${labels.map((l) => `• ${l}`).join("\n")}\n\n` +
      DISCLOSURE,
    ACK_BUTTONS,
  );
}

/** DC_S4_ACK — the disclosure, then the submit. */
async function onStep4Ack(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  const { leadId, s4 } = s4Ctx(session);
  if (!leadId) return await lostTrack(session);
  const picks = s4.picks ?? [];
  const mode = s4.mode ?? "submit";
  const external = s4.externalLender ?? null;

  const t = text(event).toLowerCase();

  if (t === "s4_redo" || t === "restart" || t === "start over") {
    await patchLeadSub(session.id, "s4", { picks: [], externalLender: null });
    return await showLenders(session, leadId, mode);
  }

  if (t !== "s4_agree" && t !== "agree" && t !== "yes") {
    await reply(
      session,
      "Tap *I agree* to send your application, or *Start over* to change your selection.",
      ACK_BUTTONS,
    );
    return;
  }

  if (!external && picks.length === 0) {
    return await askDisclosure(session, []);
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

  // --- Re-route after a rejection (E-275) ---------------------------------
  if (mode === "reselect" && !external) {
    const pick = picks[0];
    try {
      await reselectFinancing({
        leadId,
        nbfcId: pick.nbfcId,
        loanProductId: pick.productId,
        dealerCode: lead.dealer_id ?? "",
      });
    } catch (err) {
      if (err instanceof ReselectError) {
        await setSession(session.id, { current_state: DC_S4_ACK });
        await reply(session, `⚠️ ${err.message}`, ACK_BUTTONS);
        return;
      }
      console.error("[WhatsApp/step4] reselect failed:", err);
      await setSession(session.id, { current_state: DC_S4_ACK });
      await reply(
        session,
        "Sorry — something went wrong sending your application. Please tap *I agree* once more.",
        ACK_BUTTONS,
      );
      return;
    }
    await reply(session, sentMessage([pick.label]));
    return;
  }

  if (!external && !STEP4_UNLOCKED_STATUSES.has(String(lead.kyc_status))) {
    await reply(
      session,
      "✅ This application has already been sent to the lender — we'll message you here as soon as they respond.",
    );
    return;
  }
  if (external && lead.kyc_status === "loan_sanctioned") {
    // Already sanctioned (double tap after a slow first submit) — just go on.
    await reply(session, "✅ This application is already sanctioned. Let's arrange delivery.");
    await startDispatch(session, event, dealer, leadId);
    return;
  }

  try {
    // The extra documents attached over WhatsApp live on the DRAFT selection
    // row, which the submit below deletes — carry them onto the submitted row
    // exactly as the web wizard's Submit does.
    const { items: preSanctionDocs } = await getPreSanctionBucket(leadId);
    await submitStep4ProductSelection({
      leadId,
      lead,
      body: external
        ? {
            externalLender: external,
            preSanctionDocs,
            customerDisclosureAck: true,
          }
        : {
            selectedNbfcs: picks.map((p) => ({
              nbfc_id: String(p.nbfcId),
              loan_product_id: p.productId,
            })),
            preSanctionDocs,
            // The customer acknowledged it themselves, on the record, one
            // message ago — a stronger attestation than the dealer's checkbox,
            // not a weaker one. See the module header.
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

  if (external) {
    // Sanctioned on the spot — no NBFC, no admin gate. Roll straight into
    // Step 5 in the same chat: cart → margin → customer card → OTP.
    await reply(
      session,
      `🎉 *Application sent with ${BAJAJ_FALLBACK.name}.*\n\n` +
        `Let's pick the battery and confirm delivery.`,
    );
    await startDispatch(session, event, dealer, leadId);
    return;
  }

  await reply(session, sentMessage(picks.map((p) => p.label)));
}

/**
 * DC_S4_WAIT — parked. Anything sent here is an unprompted extra, unless the
 * lender has since rejected and the admin forwarded it: then the rejection
 * (and its button) is what they need to see again.
 */
async function onStep4Wait(session: SessionRow): Promise<void> {
  const { leadId } = s4Ctx(session);
  if (leadId) {
    const latest = await latestAssignment(leadId);
    if (latest?.status === "declined" && latest.rejection_forwarded_at) {
      const body = await rejectionBody(
        leadId,
        await nbfcDisplayName(latest.nbfc_id),
        latest.rejection_note ?? "",
      );
      if (body) {
        await reply(session, body, rejectionButtons(leadId));
        return;
      }
    }
  }
  await reply(
    session,
    "Your application is with the lending partner — nothing more is needed " +
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
registerLeadAction("s4_again", onStep4Again);
// DC_S4_AMT is deliberately NOT opted in to greeting re-render: free text IS
// the payload there, and "hi" is not an amount — parseRupees rejects it and
// the prompt is repeated anyway.
registerLeadState(DC_S4_AMT, onStep4Amount);
// The rest take a tap, never free text, and already re-render their prompt on
// anything they don't recognise — so a greeting here means "show me that
// message again", not "throw my application away".
registerLeadState(DC_S4_PICK, onStep4Pick, { rerenderOnGreeting: true });
registerLeadState(DC_S4_BAJAJ, onStep4Bajaj, { rerenderOnGreeting: true });
registerLeadState(DC_S4_ACK, onStep4Ack, { rerenderOnGreeting: true });
registerLeadState(DC_S4_WAIT, onStep4Wait, { rerenderOnGreeting: true });
