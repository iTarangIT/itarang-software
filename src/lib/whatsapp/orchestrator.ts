// Conversation orchestrator (design §3, §4, §5, §12). One inbound message = one
// turn. State lives on whatsapp_onboarding_sessions so a dropped chat resumes.
//
// States:
//   GREETING        — pre-first-message; the welcome + company-type ask
//   ASK_COMPANY_TYPE— waiting for the dealer's company type (drives the checklist)
//   COLLECTING_DOC  — waiting for expected_document_type; SAVE→READ→CHECK→FILL
//   ASK_FIELD       — waiting for a typed field (owner name/phone/email/finance)
//   AWAIT_CONFIRM   — masked summary sent; waiting CONFIRM / CHANGE
//   SUBMITTED       — handed off to Sales Admin; terminal for Phase 1
//
// Concurrency note: turns are serialized best-effort by message idempotency
// (whatsapp_messages.provider_message_id UNIQUE) + Meta's per-conversation
// ordering. We deliberately do NOT hold a DB advisory lock across the Gemini /
// Decentro / Meta network calls — that would tie up a connection from the small
// (max 5) pool for seconds. Rapid interleaved uploads are a Phase-2 concern.

import { and, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";

import { db } from "@/lib/db/index";
import {
  dealerCorrectionItems,
  dealerCorrectionRounds,
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
  documents as leadDocuments,
  kycDocuments,
  leads,
  personalDetails,
  whatsappMessages,
  whatsappOnboardingSessions,
} from "@/lib/db/schema";

import JSZip from "jszip";
import { City, State } from "country-state-city";

import {
  documentLabel as correctionDocumentLabel,
  fieldLabel as correctionFieldLabel,
} from "@/lib/onboarding/correction-catalog";
import { buildGstAddresses } from "@/lib/onboarding/gst-addresses";
import { normalizeAccountType } from "@/lib/onboarding/account-type";
import { catalogDocToWhatsapp } from "./correction-map";
import { getAdapter } from "./index";
import {
  ASK_FIELDS,
  blankKeyFields,
  type CompanyType,
  type DocSpec,
  docSpec,
  docTypeLabel,
  documentChecklistMessage,
  fieldLabel,
  isBlankValue,
  parseCompanyType,
  requiredDocuments,
} from "./checklist";
// E-170 dealer self-service fork disabled — see runTurn(). Re-enable
// runDealerTurn when switching back to the dealer-orchestrator increment.
// import { runDealerTurn } from "./dealer-orchestrator";
import { resolveKnownContact, resolveWhatsAppDealer } from "./dealer-identity";
import {
  type WhatsAppOperator,
  resolveOperator,
} from "./operator-identity";
import { classifyDocument } from "./extraction";
import { answerGeneralQuestion } from "./general-info";
import { classifyIntent } from "./intent";
import {
  generateManualConsentPdf,
  getSignedConsentForLead,
  renderConsentPreviewPdf,
  sendConsentOtp,
  storeSignedConsent,
  verifyConsentOtp,
} from "@/lib/kyc/consent-service";
import { ensureAdminKycQueueEntry } from "@/lib/kyc/admin-workflow";
import {
  type ActiveDealer,
  type DealerDraft,
  type InterestLevel,
  type PaymentMethod,
  createCustomerLead,
  findInProcessLeadByIdentity,
  getDealerAvailableStock,
  getDealerProductOptions,
  setLeadProduct,
  getDealerDraft,
  getDealerLeadSummary,
  listDealerDrafts,
  classifyCustomerLead,
  loadApplication,
  normalizeMobile,
  requiresConsent,
  resolveActiveDealer,
  resolveHouseDealer,
} from "./customer-lead";
import { maskAccount, maskGstin, maskIfsc, maskPan } from "./masking";
import {
  notifyOnboardingChatStarted,
  notifyOnboardingDocsUploaded,
} from "@/lib/notifications/events";
import { removeMedia, saveMedia } from "./storage";
// Session access + outbound messaging live in session-store.ts (E-214) so the
// operator state machine can reuse them without importing this module.
import {
  type Ctx,
  type SessionRow,
  attachInboundToSession,
  loadSession,
  mergeContext,
  patchApplication,
  reply,
  replyList,
  setSession,
} from "./session-store";
// E-264 — journey phases register their states here instead of adding cases to
// the two console switches. Type-only + a lookup; no phase module is imported
// at eval time, so the one-way dependency rule this file relies on is intact.
import { leadStateHandler, leadStateResumer, rerendersOnGreeting } from "./lead-states";
// Step-4 extra documents. Imported directly (not only via lead-phases) because
// the ladder below offers the step and the module hands the turn back through
// registerExtraDocsContinuation — it cannot import this file itself.
import {
  askExtraDocs,
  openExtraDocs,
  registerExtraDocsContinuation,
} from "./extra-docs-flow";
// Static side-effect import: registers every shipped journey phase. Must stay
// a static import — a dynamic one can fail silently and leave the registry empty.
import { loadLeadPhases } from "./lead-phases";
import type { InboundEvent, ListRow, ReplyButton } from "./types";
import {
  DC_ACTIVE_BATT,
  onActiveBatteryPick,
  showActiveBatteries,
} from "./active-batteries";
// Defined in ./labels so admin API routes and client components can read it
// without importing this module (and its whole dependency tree) at eval time.
// Re-exported here because three call sites already import it from here.
import { PLACEHOLDER_COMPANY } from "./labels";
export { PLACEHOLDER_COMPANY };

const MIN_CONFIDENCE = Number(process.env.WHATSAPP_MIN_CONFIDENCE ?? 0.55);

const CONFIRM_WORDS = /^(confirm|confirmed|ok|okay|yes|yep|y|haan|ha|sahi)$/i;
const CHANGE_WORDS = /^(change|edit|wrong|correct|no|nahi|galat)$/i;
// Mid-document-collection "I picked the wrong company type" intent, used when
// the dealer types a correction without naming the new type. If they DO name a
// type, parseCompanyType handles it directly (see onDocument).
const WANTS_TYPE_CHANGE = /\b(company\s*type|wrong|galat|change|update)\b/i;

// Words that (re)start the onboarding flow from the welcome message. A dealer
// who types any of these mid-flow is taken back to the company-type question; a
// dealer who has already submitted keeps the "under review" reply instead.
const GREETING_TRIGGERS =
  /^(hi+|hey+|hello+|helo|hii+|onboard(ing)?|start|begin|restart|namaste|menu)$/i;

/**
 * The subset of the greeting/menu triggers that unambiguously means "leave this
 * step", as opposed to a bare hello.
 *
 * A greeting arriving inside a tap-driven journey step re-renders that step
 * (see runConsoleTurn / runCustomerTurn) instead of clearing ctx.lead. These
 * words are the deliberate way out, so they must keep escaping — otherwise a
 * customer who actually wants the menu is trapped in a step that answers every
 * message by re-sending itself.
 */
// Hindi / Hinglish synonyms sit beside the English ones so a bot switched to
// Hindi at /admin/settings/whatsapp/language still understands the escape words.
const EXPLICIT_ESCAPE =
  /^(menu|home|back|exit|cancel|restart|start over|मेनू|मेन्यू|वापस|पीछे|रद्द|wapas|peeche|radd|band karo|बंद करो)$/i;

/** The lead a journey session is pointing at, if any. */
function leadIdOf(session: SessionRow): string | undefined {
  const ctx = (session.context ?? {}) as { lead?: { leadId?: string } };
  return ctx.lead?.leadId;
}

// Global "get me out of here" words. A dealer/customer who types any of these
// ends the current flow and is returned to the start (see runTurn → handleStop).
const STOP_TRIGGERS = /^(stop|end|exit|रुको|रोको|बंद|band|ruko|roko|khatam|खत्म)$/i;

// States that a stop word must NOT wipe: submitted / mid-correction / rejected
// applications are admin-owned, so an "exit" there keeps the state's own reply.
const STOP_EXCLUDED_STATES = new Set(["SUBMITTED", "CORRECTION", "REJECTED"]);

// Upload-method choice shown after the document checklist. The dealer can drop
// every document into one ZIP folder, or send them one at a time.
const UPLOAD_MODE_BUTTONS: ReplyButton[] = [
  { id: "upload_zip", title: "Upload all (ZIP)" },
  { id: "upload_one", title: "Send one by one" },
];

// Dealer is telling us they can't provide the current document / value and want
// to proceed — a plain "no", "not available", "I don't have this document",
// "skip", "move further", etc. (incl. common typos and Hindi "nahi"). We mark
// the item for manual admin follow-up and continue instead of looping. Only
// checked in COLLECTING_DOC, so a "No" to the financing question is unaffected.
const SKIP_WORDS =
  /(^|\b)(no|nope|nah|nahi+|naa+|nahin|नहीं|नही|n\/?a|skip|chhodo|chodo|छोड़ो|छोड़ दो|aage|आगे|next|proceed|continue|move\s*(on|ahead|forward|further)|don'?t\s*have|do\s*not\s*have|have\s*not|haven'?t|not?\s*avai\w*|un\s*avai\w*|no\s*(doc|document|more)|only\s*this|this\s*(is\s*)?(all|only)|have\s*this\s*only|that'?s\s*all|nothing\s*else|can'?t\s*(get|provide|share|do)|cannot\s*(get|provide|share|do)|nahi\s*hai|aage\s*(badho|chalo))(\b|$)/i;

// Company-type choices shown as tappable reply buttons (WhatsApp allows ≤3).
// The button id IS the canonical CompanyType, so a tap maps straight through
// with no free-text parsing. LLP is intentionally not offered here.
const COMPANY_TYPE_BUTTONS: ReplyButton[] = [
  { id: "sole_proprietorship", title: "Sole Proprietor" },
  { id: "partnership_firm", title: "Partnership" },
  { id: "private_limited_firm", title: "Private Limited" },
];

// The entry front door is now a free-text prompt, not a tappable menu. The user
// types what they need and classifyIntent() (see onChooseFlow) routes them. The
// button IDs "flow_dealer" / "flow_customer" / "flow_info" are still honoured in
// onChooseFlow so stale-menu / known-contact button taps keep working.

// The website loan-calculator sends this interactive reply-button id ("Start
// application") under a customer's EMI schemes. A tap means a CUSTOMER wants to
// buy the battery they were quoted, so we skip the free-text classify + the
// Customer/Dealer role ask and start customer new-lead onboarding straight away
// (see the intercept in runTurn). Kept in sync with the website's
// ONBOARDING_START_ID in src/lib/whatsapp/otp-delivery.ts.
const WEBSITE_APPLY_BUTTON_ID = "onboarding_start";

function isWebsiteApplyButton(event: InboundEvent): boolean {
  return (
    event.type === "interactive" &&
    (event.text ?? "").trim() === WEBSITE_APPLY_BUTTON_ID
  );
}

// Single welcome + open question shown on first contact (and whenever we re-ask
// what the sender needs). No buttons — their typed reply is classified.
const HELP_PROMPT =
  "👋 Welcome to *iTarang*! How can I help you today?\n\nJust type your question or tell me what you'd like to do.";

// Shown when the sender's message isn't a clear dealer/customer request (a
// product/price question, something off-topic, etc.): acknowledge that a human
// will follow up, then ask their role so we can still start the right flow.
const TEAM_FOLLOWUP =
  "🙏 Thanks for your message! Our iTarang team will get in touch with you shortly.";

// Role ask shown after TEAM_FOLLOWUP. A tap routes straight into the matching
// onboarding flow (handled in onChooseFlow); typed "customer"/"dealer" also work.
const ROLE_BUTTONS: ReplyButton[] = [
  { id: "role_customer", title: "Customer" },
  { id: "role_dealer", title: "Dealer" },
];

// Lead-in acknowledgements shown the moment we route into each onboarding flow
// (via a role-button tap OR a direct intent classification), just before the
// flow's first question.
const CUSTOMER_INTRO =
  "👍 Great! You're here to *purchase a battery / charger*. For that we'll need a few details from you — please share the following 👇";
const DEALER_INTRO =
  "👍 Great! To become an *iTarang dealer*, we'll need some information from you, as follows 👇";

const KNOWN_COMPANY_TYPES: readonly string[] = [
  "sole_proprietorship",
  "partnership_firm",
  "private_limited_firm",
  "llp",
];

// The ONE business decision not derivable from documents: whether the dealer
// wants customer financing. It drives the agreement flow (finance-enabled
// dealers need the Digio agreement before admin approval), so we ask it as a
// Yes/No tap right before submission.
const FINANCE_BUTTONS: ReplyButton[] = [
  { id: "finance_yes", title: "Yes" },
  { id: "finance_no", title: "No" },
];

/** Resolve a Yes/No financing answer from a button tap or typed text. */
function financeAnswer(event: InboundEvent): boolean | null {
  const t = (event.text ?? "").trim().toLowerCase();
  if (event.type === "interactive") {
    if (t === "finance_yes") return true;
    if (t === "finance_no") return false;
  }
  if (/^(yes|y|haan|ha|sure|yep|ji|jee|हाँ|हां|जी|ok|okay|theek hai|ठीक है)$/i.test(t)) return true;
  if (/^(no|n|nahi|nahin|nope|नहीं|नही|na)$/i.test(t)) return false;
  return null;
}

/** Validate an interactive button id as a CompanyType. */
function asCompanyType(id: string | null | undefined): CompanyType | null {
  return id && KNOWN_COMPANY_TYPES.includes(id) ? (id as CompanyType) : null;
}

// After this many failed attempts at one document (illegible / wrong type /
// unreadable key field), stop nagging and move on — the admin follows up.
const MAX_DOC_ATTEMPTS = 3;

// ── Public entry points (called from the webhook) ───────────────────────────

/** Insert the inbound message; returns false if it's a duplicate delivery. */
export async function recordInbound(event: InboundEvent): Promise<boolean> {
  const inserted = await db
    .insert(whatsappMessages)
    .values({
      provider_message_id: event.providerMessageId,
      direction: "inbound",
      message_type: event.type,
      text_body: event.text ?? null,
      media_provider_id: event.mediaProviderId ?? null,
      raw_payload: event.raw as any,
    })
    .onConflictDoNothing({ target: whatsappMessages.provider_message_id })
    .returning({ id: whatsappMessages.id });
  return inserted.length > 0;
}

/** Update delivery status from a Meta status webhook (sent/delivered/read/failed). */
export async function updateDeliveryStatus(event: InboundEvent): Promise<void> {
  if (!event.providerMessageId || !event.deliveryStatus) return;
  await db
    .update(whatsappMessages)
    .set({ delivery_status: event.deliveryStatus })
    .where(eq(whatsappMessages.provider_message_id, event.providerMessageId));
}

/** Run one conversation turn for a dealer message. */
export async function runTurn(event: InboundEvent): Promise<void> {
  if (event.type === "status") {
    await updateDeliveryStatus(event);
    return;
  }

  // E-264 — the journey phases registered their states at module load; this
  // call exists so the side-effect import cannot be tree-shaken away.
  loadLeadPhases();

  // E-243 — a dealer tapping Approve / Decline on a quotation.
  //
  // FIRST, ahead of every other gate including the operator check and the
  // session itself. The sender may be an approved dealer (who would land in the
  // lead console), a lead who was never onboarded (who would land in the
  // onboarding state machine), or neither — and in all three cases the answer
  // to a quotation is what the message means. Feeding `quote_approve:<uuid>`
  // into "what is your company name?" would both lose the decision and corrupt
  // a draft.
  //
  // It only ever claims a message carrying one of the two button IDs we mint,
  // so free text is untouched and every existing flow behaves exactly as
  // before. Wrapped because a failure here must not swallow the dealer's
  // message — on error we fall through to the normal flow.
  try {
    const { handleQuotationReply } = await import("./quotationReply");
    if (await handleQuotationReply(event)) return;
  } catch (err) {
    console.error("[WhatsApp/orchestrator] quotation-reply gate failed:", err);
  }

  // E-170 — dealer self-service fork. DISABLED: this WIP simpler flow
  // (dealer-orchestrator.ts: name→mobile→email→address→"finish in portal")
  // was intercepting approved dealers before they reached the complete
  // post-approval console (runConsoleTurn below: mobile→interest→payment→KYC
  // docs→consent). Approved dealers now fall through to runConsoleTurn so they
  // get the full New-Lead flow. Re-enable this block to switch back to the
  // dealer-orchestrator increment once it reaches feature parity.
  // try {
  //   const dealer = await resolveWhatsAppDealer(event.waPhone);
  //   if (dealer) {
  //     return await runDealerTurn(event, dealer);
  //   }
  // } catch (err) {
  //   console.error("[WhatsApp/orchestrator] dealer-fork lookup failed:", err);
  //   // Fall through to onboarding rather than dropping the message.
  // }

  // E-214 — internal onboarding operator. Resolved BEFORE the session so an
  // allowlisted number gets a bare `operator_hub` row instead of a dealer draft.
  const operator = await resolveOperator(event.waPhone);

  const session = await getOrCreateSession(event, operator);
  await setSession(session.id, { last_inbound_at: new Date() });
  // recordInbound() ran in the webhook before we knew the session, so the row is
  // sitting there with session_id = NULL. Attribute it now (an operator turn
  // re-attributes it to the dealer file it actually belongs to).
  await attachInboundToSession(event.providerMessageId, session.id);

  // E-214 — internal onboarding operator: one number, many dealer files. This
  // gate is placed HERE, ahead of every other gate, on purpose:
  //
  //  • Ahead of the approved-dealer console below. That gate reads
  //    session.application_id → resolveActiveDealer(); if an operator's hub
  //    still pointed at a dealer file that later got approved, the OPERATOR
  //    would be dropped into that dealer's lead console and create leads
  //    attributed to a dealer they don't own. Returning here makes that
  //    structurally unreachable. (closeFile() also nulls the hub's
  //    application_id, so the trap is disarmed twice.)
  //  • Ahead of the stop word. handleStop() wipes ctx.docs/answers on the row it
  //    is given — catastrophic mid-file. In operator mode "stop" means "park
  //    this dealer file and go back to the menu", which runOperatorTurn owns.
  //  • Ahead of the website Apply button. An allowlisted internal number is
  //    never a retail customer.
  //
  // Imported lazily so operator-orchestrator.ts can import this module for the
  // shared onboarding state machine without a module-eval cycle.
  if (operator) {
    const { runOperatorTurn } = await import("./operator-orchestrator");
    return await runOperatorTurn(session, event, operator);
  }

  // E-264 — a journey button press (cb_start:<lead>, of_pick:<lead>:<nbfc>, …).
  //
  // Placed HERE, and the position is load-bearing in both directions:
  //  • AFTER the operator gate, which returns early — an allowlisted internal
  //    number is never a lead actor, and that gate must keep winning.
  //  • BEFORE the console gate below. A `cb_start:` tap arriving while the
  //    session sits at DC_MENU would otherwise fall into onMenuChoice's
  //    `default:` and be silently swallowed as an unrecognised menu row.
  //
  // Button ids cannot collide with the stop word or a greeting, so nothing
  // downstream is starved by running this first. Same try/catch-and-fall-through
  // shape as the E-243 quotation gate: a failure here must not eat the message.
  try {
    const { handleLeadAction } = await import("./leadActionReply");
    if (await handleLeadAction(session, event)) return;
  } catch (err) {
    console.error("[WhatsApp] lead-action gate failed:", err);
  }

  // E-264 — the customer came back, so Meta's 24-hour window is open again.
  // Deliver anything we had to park while it was shut, and reset the nudge
  // budget. Runs after the lead-action gate so an explicit button tap is
  // answered on its own terms rather than being pre-empted by a stale prompt.
  try {
    const { replayParkedPrompt, onInboundResetNudges } = await import(
      "./outbound"
    );
    await onInboundResetNudges(session.id);
    if (session.pending_prompt) {
      const replayed = await replayParkedPrompt(await loadSession(session.id));
      // A replayed prompt IS this turn's reply: the customer's "hi" was an
      // answer to the doorbell, not to whatever state the session is parked in.
      if (replayed) return;
    }
  } catch (err) {
    console.error("[WhatsApp] parked-prompt replay failed:", err);
  }

  // Global stop word (stop / end / exit): bail out of whatever flow is active
  // and return to the start. Runs BEFORE every other gate so it works from the
  // dealer console, customer flow, onboarding and Q&A alike. Admin-owned states
  // (submitted / mid-correction / rejected) are left untouched — an "exit"
  // there keeps their status reply instead of wiping the application.
  if (isStopWord(event) && !STOP_EXCLUDED_STATES.has(session.current_state)) {
    return await handleStop(session);
  }

  // Website loan-calculator "Start application" button: the sender tapped Apply
  // under the EMI schemes they were quoted, so they are a CUSTOMER wanting to
  // buy the battery. Start customer new-lead onboarding directly — skip the
  // free-text classify and the "are you a customer or a dealer?" role ask.
  //
  // This runs BEFORE the approved-dealer console gates on purpose: the loan
  // calculator is a customer-facing surface, so even a sender whose number is a
  // registered dealer is acting as a customer here and must get the new-lead
  // flow (they can still type "hi" to reach their dealer console). Only the
  // global stop word takes precedence.
  if (isWebsiteApplyButton(event)) {
    return await enterCustomerFlow(session);
  }

  // Post-approval dealer console: once the dealer's onboarding application is
  // admin-approved, the SAME WhatsApp number switches from the onboarding state
  // machine to the lead-creation console. This must run BEFORE the greeting
  // so an approved dealer's "hi" opens the menu instead of restarting onboarding.
  const application = await loadApplication(session.application_id);
  const dealer = await resolveActiveDealer(application);
  if (dealer) {
    return await runConsoleTurn(session, event, dealer);
  }

  // Approved dealer whose SESSION doesn't point at their approved application,
  // so the gate above misses them. Two ways that happens:
  //   • web-onboarded — matched on dealers.owner_phone; their session's
  //     application row is just a stray WhatsApp draft;
  //   • E-214 operator-uploaded — an internal operator collected every document
  //     from their own number, so the dealer's number has no session at all and
  //     their first "hi" mints a fresh draft.
  // Both route to the SAME post-approval console. Previously only the "web"
  // match was honoured here, which left operator-onboarded dealers stuck in
  // onboarding forever; resolveWhatsAppDealer's "whatsapp" branch now checks
  // dealer_account_status='active' too, so it is as strict as resolveActiveDealer.
  // This must never call the disabled E-170 runDealerTurn fork.
  try {
    const webDealer = await resolveWhatsAppDealer(event.waPhone);
    if (webDealer?.dealerUserId) {
      return await runConsoleTurn(session, event, {
        dealerCode: webDealer.dealerCode,
        uploaderId: webDealer.dealerUserId,
        dealerName: webDealer.dealerName || session.wa_contact_name || "there",
        // resolveWhatsAppDealer's "web" branch reads dealers.finance_enabled —
        // the same canonical column the E-105 lead gate uses.
        financeEnabled: webDealer.financeEnabled,
      });
    }
  } catch (err) {
    console.error("[WhatsApp/orchestrator] web-dealer lookup failed:", err);
    // Fall through to onboarding rather than dropping the message.
  }

  // Customer self-onboarding (entry-chooser option 2): a non-dealer building a
  // lead attributed to the house dealer. Runs its own thin dispatcher so it can
  // never surface the dealer console menu (Drafts/Inventory/Help). Only reached
  // for a non-approved sender (resolveActiveDealer returned null above).
  if (((session.context ?? {}) as Ctx).flow === "customer") {
    return await runCustomerTurn(session, event);
  }

  try {
    return await runOnboardingStates(session, event);
  } catch (err) {
    console.error("[WhatsApp/orchestrator] turn failed:", err);
    await reply(
      session,
      "Sorry, something went wrong on our side. Please try again in a moment.",
    );
  }
}

/**
 * The dealer-onboarding state machine for ONE session row.
 *
 * Split out of runTurn (E-214) so the operator flow can drive it against a
 * per-dealer `operator_file` session while the replies still go to the
 * operator's own number (see session-store.ts). Every handler below reads and
 * writes only the row it is handed, which is what makes many dealer files per
 * WhatsApp number work without touching the document pipeline.
 *
 * Errors propagate — the caller owns the "something went wrong" reply so the
 * message lands on the right conversation.
 */
export async function runOnboardingStates(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  // A greeting word (hi/hello/menu/start…) at the entry of the flow re-greets
  // (with known-contact recognition); mid-application it offers Resume /
  // Start Over instead of restarting. Post-submission states keep their own
  // replies (see GREETING_EXCLUDED_STATES).
  if (
    isGreetingWord(event) &&
    !GREETING_EXCLUDED_STATES.has(session.current_state)
  ) {
    if (!hasOnboardingProgress(session)) {
      return await greetEntry(session, event);
    }
    if (RESUMABLE_STATES.has(session.current_state)) {
      return await askResume(session);
    }
    // Progress in a non-resumable state — fall through; the state handler
    // simply re-prompts (e.g. an impatient "hi" during a document read).
  }

  switch (session.current_state) {
    case "GREETING":
      return await greetEntry(session, event);
    case "CHOOSE_FLOW":
      return await onChooseFlow(session, event);
    case "GENERAL_INFO":
      return await onGeneralInfo(session, event);
    case "ASK_RESUME":
      return await onAskResume(session, event);
    case "ASK_COMPANY_TYPE":
      return await onCompanyType(session, event);
    case "ASK_UPLOAD_MODE":
      return await onUploadMode(session, event);
    case "COLLECTING_DOC":
      return await onDocument(session, event);
    case "ASK_FINANCE":
      return await onFinance(session, event);
    case "ASK_FIELD":
      return await onField(session, event);
    case "CONFIRM_SIGNER":
      return await onSignerConfirm(session, event);
    case "ASK_SIGNER_CHOICE":
      return await onSignerChoice(session, event);
    case "ASK_SIGNER_FIELD":
      return await onSignerField(session, event);
    case "AWAIT_CONFIRM":
      return await onConfirm(session, event);
    case "CORRECTION":
      return await onCorrection(session, event);
    case "REJECTED":
      return void (await reply(
        session,
        "This application was not approved. Please contact our team if you'd like to discuss it.",
      ));
    case "SUBMITTED":
      return void (await reply(
        session,
        "Your application is already submitted and under review. Our team will contact you shortly.",
      ));
    default:
      return await greetEntry(session, event);
  }
}

// ── State handlers ──────────────────────────────────────────────────────────

async function onGreeting(session: SessionRow): Promise<void> {
  // First contact: send ONE welcome message and ask, as free text, what the
  // sender needs. Their reply is classified by classifyIntent() in onChooseFlow:
  //   • dealer intent   → dealer onboarding (company-type document collection)
  //   • customer intent → customer self-onboarding a lead (house dealer)
  //   • anything else   → "our team will get in touch" + a Customer/Dealer ask.
  await reply(session, HELP_PROMPT);
  await setSession(session.id, { current_state: "CHOOSE_FLOW" });
}

// Ask whether an unclassified sender is a customer or a dealer, so we can still
// start the right onboarding flow. Called after TEAM_FOLLOWUP. Stays in
// CHOOSE_FLOW — a tap on role_customer / role_dealer comes back here and routes.
async function askRole(session: SessionRow): Promise<void> {
  await reply(session, TEAM_FOLLOWUP);
  await reply(
    session,
    "Meanwhile, are you a *customer* or a *dealer*? Tap below 👇",
    ROLE_BUTTONS,
  );
}

// Enter the CUSTOMER self-onboarding (new-lead) flow: attribute the lead to the
// house dealer and start lead capture (asks for the customer's mobile number).
// Shared by the free-text / role-button routing in onChooseFlow AND the website
// "Start application" button intercept in runTurn, so both reach the exact same
// flow. Pre-checks the house dealer so we never strand the customer mid-flow.
async function enterCustomerFlow(session: SessionRow): Promise<void> {
  const houseDealer = await resolveHouseDealer();
  if (!houseDealer) {
    console.error(
      "[WhatsApp/customer] house dealer unresolved — cannot start customer lead flow",
    );
    await reply(
      session,
      "Sorry, we can't take new customer leads right now. Please try again later.",
    );
    return;
  }
  await mergeContext(session, (ctx) => {
    ctx.flow = "customer";
  });
  // Acknowledge, then start the lead capture (asks for the mobile number).
  await reply(session, CUSTOMER_INTRO);
  return await startNewLead(await loadSession(session.id));
}

// CHOOSE_FLOW — route the free-text front door. The sender types what they need
// and classifyIntent() (Gemini) picks dealer / customer / general — or flags it
// too hard, in which case we tell them the team will follow up and ask their
// role (Customer/Dealer). Explicit button-id taps (known-contact greetings,
// stale menus, and the role buttons) are honoured directly, and if the LLM is
// unavailable we fall back to a keyword regex so the bot keeps working.
async function onChooseFlow(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const raw = (event.text ?? "").trim();
  const t = raw.toLowerCase();

  // ── Branch targets (reused by the button, LLM and keyword paths) ──────────
  const goDealer = () =>
    // The dealer intro leads straight into the company-type question below.
    askCompanyType(session, DEALER_INTRO);

  const goCustomer = () => enterCustomerFlow(session);

  const goInfo = () => startGeneralInfo(session);

  // "Main Menu" button on the recognized-contact greetings → re-ask (free text).
  if (t === "show_menu") {
    await reply(session, HELP_PROMPT);
    return;
  }

  // 1. Honour explicit button-id taps: the entry chooser / known-contact menus
  //    (flow_*) and the Customer/Dealer role buttons (role_*).
  if (t === "flow_dealer" || t === "role_dealer") return await goDealer();
  if (t === "flow_customer" || t === "role_customer") return await goCustomer();
  if (t === "flow_info") return await goInfo();

  // 2. Free text → classify with the LLM and route.
  if (raw) {
    const res = await classifyIntent(raw);
    if (res.ok) {
      switch (res.intent) {
        case "dealer_onboarding":
          return await goDealer();
        case "customer_onboarding":
          return await goCustomer();
        default:
          // general_info / too_hard / low confidence → the bot can't serve this
          // request directly (e.g. "battery information and price"): tell them
          // the team will follow up, then ask their role so we can still start
          // the right onboarding flow.
          return await askRole(session);
      }
    }
    // res.ok === false → LLM/key unavailable. Fall through to keyword routing.
  }

  // 3. Deterministic keyword fallback (LLM down or empty message).
  const wantsDealer = /\bdealer\b/.test(t);
  const wantsCustomer = /\b(customer|lead)\b/.test(t);
  if (wantsDealer) return await goDealer();
  if (wantsCustomer) return await goCustomer();

  // Nothing matched → team follow-up + role ask.
  return await askRole(session);
}

// ── GENERAL_INFO — grounded AI Q&A (entry-chooser option 3) ─────────────────

// Words that leave the Q&A and return to the entry menu. "menu"/"hi" etc. also
// exit earlier via the greeting-word check (an info session has no onboarding
// progress); this covers back/exit/stop, which aren't greeting triggers.
const INFO_EXIT_WORDS =
  /^(menu|back|exit|stop|home|main\s*menu|मेनू|मेन्यू|वापस|पीछे|रुको|बंद|wapas|peeche|ruko|band)$/i;
// LLM-spend guardrails per info session.
const INFO_MAX_TURNS = 15;
const INFO_HISTORY_PAIRS = 4;
const INFO_ANSWER_HISTORY_CHARS = 300;

async function startGeneralInfo(session: SessionRow): Promise<void> {
  await mergeContext(session, (ctx) => {
    ctx.info = { turns: 0, history: [] };
  });
  await setSession(session.id, { current_state: "GENERAL_INFO" });
  await reply(
    session,
    "💬 Sure! Ask me anything about iTarang — dealer onboarding, customer registration or financing.\n\n_Type *menu* anytime to go back to the main options._",
  );
}

async function onGeneralInfo(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const t = (event.text ?? "").trim();

  // A tap on a (possibly stale) entry-menu button still routes normally.
  if (event.type === "interactive" && /^(flow_\w+|show_menu)$/.test(t)) {
    return await onChooseFlow(session, event);
  }

  if (event.type === "text" && INFO_EXIT_WORDS.test(t)) {
    await mergeContext(session, (ctx) => {
      ctx.info = undefined;
    });
    return await onGreeting(session);
  }

  if (event.type !== "text" || !t) {
    await reply(
      session,
      "I can only answer typed questions here — type *menu* for the main options.",
    );
    return;
  }

  const info = ((session.context ?? {}) as Ctx).info ?? {
    turns: 0,
    history: [],
  };

  if (info.turns >= INFO_MAX_TURNS) {
    await reply(
      session,
      "We've covered a lot in this chat! For anything more, our team is happy to help — email *support@itarang.com*.",
    );
    await reply(session, HELP_PROMPT);
    await setSession(session.id, { current_state: "CHOOSE_FLOW" });
    return;
  }

  const res = await answerGeneralQuestion(
    t,
    (info.history ?? []).slice(-INFO_HISTORY_PAIRS),
  );
  if (!res.ok || !res.answer) {
    await reply(
      session,
      "Sorry, I couldn't fetch that right now 🙏",
    );
    await reply(session, HELP_PROMPT);
    await setSession(session.id, { current_state: "CHOOSE_FLOW" });
    return;
  }

  const turns = info.turns + 1;
  // Re-surface the escape hatch every few answers without nagging on each one.
  const suffix =
    turns % 3 === 0 ? "\n\n_Type *menu* to go back to the main options._" : "";
  await reply(session, res.answer + suffix);
  await mergeContext(session, (ctx) => {
    const prev = ctx.info ?? { turns: 0, history: [] };
    prev.turns = turns;
    prev.history = [
      ...(prev.history ?? []),
      { q: t, a: (res.answer ?? "").slice(0, INFO_ANSWER_HISTORY_CHARS) },
    ].slice(-INFO_HISTORY_PAIRS);
    ctx.info = prev;
  });
}

// One turn for a CUSTOMER self-onboarding a lead (entry-chooser option 2). A
// thin dispatcher over the DC_LEAD_* subset only — reuses the exact lead-capture
// handlers the dealer console uses, but with the house dealer as the attributed
// dealer and WITHOUT ever exposing the dealer menu (Drafts/Inventory/Help).
async function runCustomerTurn(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const houseDealer = await resolveHouseDealer();
  if (!houseDealer) {
    console.error(
      "[WhatsApp/customer] house dealer unresolved mid-flow — resetting",
    );
    return await finishCustomerFlow(
      session,
      "Sorry, we can't continue right now. Please try again later.",
    );
  }

  try {
    const text = (event.text ?? "").trim();
    // A typed greeting abandons the in-progress lead and returns to the chooser
    // — except in a tap-driven journey step, where it re-renders instead. Same
    // reasoning as the dealer console above: for a self-serve customer the lead
    // pointer is the ONLY route back into their own application, so treating
    // "hi" as "throw it away" loses an approved loan to a reflex.
    if (event.type === "text" && GREETING_TRIGGERS.test(text)) {
      const journey = leadStateHandler(session.current_state);
      if (
        journey &&
        rerendersOnGreeting(session.current_state) &&
        !EXPLICIT_ESCAPE.test(text) &&
        leadIdOf(session)
      ) {
        return await journey(session, event, houseDealer);
      }
      await mergeContext(session, (ctx) => {
        ctx.flow = undefined;
        ctx.lead = undefined;
      });
      await setSession(session.id, { current_state: "GREETING" });
      return await onGreeting(await loadSession(session.id));
    }

    switch (session.current_state) {
      case "DC_LEAD_MOBILE":
        return await onLeadMobile(session, event);
      case "DC_LEAD_INTEREST":
        return await onLeadInterest(session, event, houseDealer);
      case "DC_LEAD_PAYMENT":
        return await onLeadPayment(session, event, houseDealer);
      case "DC_LEAD_PRODUCT":
        return await onLeadProduct(session, event, houseDealer);
      case "DC_LEAD_DOCS_MODE":
        return await onLeadDocsMode(session, event, houseDealer);
      case "DC_LEAD_DOCS":
        return await onLeadDocs(session, event, houseDealer);
      case "DC_LEAD_CONSENT_CHANNEL":
        return await onConsentChannel(session, event, houseDealer);
      case "DC_LEAD_CONSENT_WAIT":
        return await onConsentWait(session, event);
      case "DC_LEAD_CONSENT_OTP_WAIT":
        return await onConsentOtpWait(session, event, houseDealer);
      case "DC_LEAD_FINANCE_Q":
        return await onLeadFinanceQuestion(session, event);
      case "DC_LEAD_CONSENT_REVIEW":
        return await onConsentReview(session, event);
      default: {
        // E-264 — same journey-state table the dealer console consults. This is
        // the half that makes "identical flow for both actors" structural rather
        // than a promise: there is one registry, so a state cannot exist for the
        // dealer and be missing for the customer.
        const handler = leadStateHandler(session.current_state);
        if (handler) return await handler(session, event, houseDealer);
        // Completed or stale state → thank-you + reset to the chooser.
        return await finishCustomerFlow(session);
      }
    }
  } catch (err) {
    console.error("[WhatsApp/customer] turn failed:", err);
    await reply(
      session,
      "Sorry, something went wrong on our side. Please send *hi* to start again.",
    );
  }
}

// End a customer lead flow: clear the flow/lead context and reset to GREETING so
// the next message re-shows the entry chooser.
async function finishCustomerFlow(
  session: SessionRow,
  headline?: string,
): Promise<void> {
  await mergeContext(session, (ctx) => {
    ctx.flow = undefined;
    ctx.lead = undefined;
  });
  await setSession(session.id, { current_state: "GREETING" });
  await reply(
    session,
    headline ??
      "🎉 Thanks! Our team will review the details and contact the customer shortly.\n\nSend *hi* to start again.",
  );
}

// ── Greeting entry: known-contact recognition + mid-flow resume ─────────────

/** A typed greeting word (hi/hello/menu/start…). */
function isGreetingWord(event: InboundEvent): boolean {
  return (
    event.type === "text" && GREETING_TRIGGERS.test((event.text ?? "").trim())
  );
}

/** A typed stop word (stop/end/exit/quit/cancel). */
function isStopWord(event: InboundEvent): boolean {
  return (
    event.type === "text" && STOP_TRIGGERS.test((event.text ?? "").trim())
  );
}

// End whatever flow is active: clear the in-conversation context (onboarding
// progress, customer lead, Q&A session) and return the session to GREETING so
// the next message starts fresh. The application row + session are kept (same
// sender); an approved dealer's next message re-enters the console via the gate
// in runTurn. We confirm the stop rather than dumping the welcome, so the user
// isn't nagged — they can send "hi" when they're ready.
export async function handleStop(session: SessionRow): Promise<void> {
  await mergeContext(session, (ctx) => {
    ctx.flow = undefined;
    ctx.lead = undefined;
    ctx.info = undefined;
    ctx.resumeState = undefined;
    ctx.docs = {};
    ctx.answers = {};
    ctx.fieldIndex = 0;
    ctx.skipped = [];
    ctx.attempts = {};
  });
  await setSession(session.id, {
    current_state: "GREETING",
    detected_company_type: null,
    expected_document_type: null,
    session_status: "active",
  });
  await reply(
    session,
    "👋 Okay, I've ended that for now. Send *hi* anytime to start again.",
  );
}

// States where a greeting word keeps the state's own reply instead of
// re-greeting: SUBMITTED ("under review"), CORRECTION / REJECTED (a stray "hi"
// must NOT wipe a mid-correction or declined application), GREETING (the
// switch already greets) and the resume prompt itself.
export const GREETING_EXCLUDED_STATES = new Set([
  "GREETING",
  "SUBMITTED",
  "CORRECTION",
  "REJECTED",
  "ASK_RESUME",
]);

// Mid-application states we can safely interrupt with the Resume / Start Over
// prompt and later re-prompt (promptForState) without losing collected
// progress. Anything else with progress falls through to its state handler —
// dealers often type "hi" out of impatience during a slow document read, and
// the handler simply re-prompts the step.
export const RESUMABLE_STATES = new Set([
  "ASK_COMPANY_TYPE",
  "ASK_UPLOAD_MODE",
  "COLLECTING_DOC",
  "ASK_FINANCE",
  "ASK_FIELD",
  "CONFIRM_SIGNER",
  "ASK_SIGNER_CHOICE",
  "ASK_SIGNER_FIELD",
  "AWAIT_CONFIRM",
]);

/** Real progress = a chosen company type or at least one collected document. */
function hasOnboardingProgress(session: SessionRow): boolean {
  const ctx = (session.context ?? {}) as Ctx;
  return (
    !!session.detected_company_type || Object.keys(ctx.docs ?? {}).length > 0
  );
}

// Buttons on the recognized-contact greetings (staff / returning customer):
// they aren't onboarding, so lead with an escape into the chooser + Q&A.
const KNOWN_CONTACT_BUTTONS: ReplyButton[] = [
  { id: "show_menu", title: "Main Menu" },
  { id: "flow_info", title: "General Information" },
];

function humanizeRole(role: string): string {
  return role
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Entry greeting with known-contact recognition: internal staff and returning
// customers (matched on the registered mobile number) get a personalised
// greeting with a Main-Menu escape; everyone else gets the standard 3-option
// chooser via a clean restart. Approved dealers never reach here — the console
// gates in runTurn own them.
async function greetEntry(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  try {
    const known = await resolveKnownContact(event.waPhone || session.wa_phone);
    if (known?.kind === "staff") {
      await mergeContext(session, (ctx) => {
        ctx.known = { kind: "staff", name: known.name, role: known.role };
      });
      await reply(
        session,
        `Hi *${known.name}* 👋 You're registered with iTarang as *${humanizeRole(known.role)}*.\n\nThis channel handles dealer & customer onboarding and product questions — tap an option below 👇`,
        KNOWN_CONTACT_BUTTONS,
      );
      await setSession(session.id, { current_state: "CHOOSE_FLOW" });
      return;
    }
    if (known?.kind === "lead") {
      // The extraction placeholder name ("Customer") isn't worth greeting with.
      const name =
        known.name && known.name !== "Customer" ? ` *${known.name}*` : "";
      const ref = known.referenceId ? ` *${known.referenceId}*` : "";
      const status = (known.status || "in process").replace(/_/g, " ");
      await mergeContext(session, (ctx) => {
        ctx.known = { kind: "lead", name: known.name ?? "" };
      });
      await reply(
        session,
        `Welcome back${name}! 👋 We already have your enquiry${ref} on file — current status: *${status}*. Our team will follow up.\n\nNeed anything else? Tap an option below 👇`,
        KNOWN_CONTACT_BUTTONS,
      );
      await setSession(session.id, { current_state: "CHOOSE_FLOW" });
      return;
    }
  } catch (err) {
    // Recognition is best-effort — never block the greeting on a lookup error.
    console.error("[WhatsApp/orchestrator] known-contact lookup failed:", err);
  }
  await restartOnboarding(session);
}

const RESUME_BUTTONS: ReplyButton[] = [
  { id: "resume_app", title: "Resume" },
  { id: "restart_app", title: "Start Over" },
];

// A greeting word arrived mid-application (real progress + resumable state):
// offer to continue or start fresh instead of silently re-prompting.
async function askResume(session: SessionRow): Promise<void> {
  const application = await loadApplication(session.application_id);
  const name =
    application?.owner_name || session.wa_contact_name || "there";
  await mergeContext(session, (ctx) => {
    ctx.resumeState = session.current_state;
  });
  await setSession(session.id, { current_state: "ASK_RESUME" });
  await reply(
    session,
    `Hi *${name}* 👋 You have a dealer application in progress.\n\nContinue where you left off, or start fresh?`,
    RESUME_BUTTONS,
  );
}

async function onAskResume(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const t = (event.text ?? "").trim().toLowerCase();
  const prior = ((session.context ?? {}) as Ctx).resumeState;

  if (t === "resume_app" || /^(resume|continue|yes|y|haan|ha)$/i.test(t)) {
    await mergeContext(session, (ctx) => {
      ctx.resumeState = undefined;
    });
    if (!prior || !RESUMABLE_STATES.has(prior)) {
      return await restartOnboarding(session);
    }
    await setSession(session.id, { current_state: prior });
    return await promptForState(await loadSession(session.id), prior);
  }

  if (t === "restart_app" || /^(restart|start\s*over|start\s*fresh|new)$/i.test(t)) {
    await mergeContext(session, (ctx) => {
      ctx.resumeState = undefined;
    });
    return await restartOnboarding(session);
  }

  await reply(
    session,
    "Please tap *Resume* to continue your application, or *Start Over* to begin again 👇",
    RESUME_BUTTONS,
  );
}

// Re-issue the question a resumed state is waiting on. The ask* helpers set
// current_state themselves, so the restored state stays consistent.
async function promptForState(
  session: SessionRow,
  state: string,
): Promise<void> {
  const CONTINUING = "Great — continuing where you left off.";
  switch (state) {
    case "ASK_COMPANY_TYPE":
      return await askCompanyType(session, CONTINUING);
    case "ASK_UPLOAD_MODE":
      return await askUploadMode(session, CONTINUING);
    case "COLLECTING_DOC":
      // advanceDocument recomputes the next missing/blank document and asks
      // for it (also re-setting expected_document_type).
      await reply(session, CONTINUING);
      return await advanceDocument(session);
    case "ASK_FINANCE":
      return await askFinance(session, CONTINUING);
    case "CONFIRM_SIGNER":
    case "ASK_SIGNER_CHOICE":
    case "ASK_SIGNER_FIELD":
      await reply(session, CONTINUING);
      return await sendSignerConfirm(session);
    case "AWAIT_CONFIRM":
      await reply(session, CONTINUING);
      return await sendSummary(session);
    default:
      return await reply(
        session,
        `${CONTINUING} Please reply to the last question above 👆`,
      );
  }
}

// Clear any collected progress and re-greet, so "hi" mid-flow is a genuine
// fresh start. The application row + session are kept (same dealer); only the
// in-conversation context is reset.
export async function restartOnboarding(session: SessionRow): Promise<void> {
  await mergeContext(session, (ctx) => {
    ctx.docs = {};
    ctx.answers = {};
    ctx.fieldIndex = 0;
    ctx.skipped = [];
    ctx.attempts = {};
    ctx.info = undefined;
    ctx.resumeState = undefined;
  });
  await setSession(session.id, {
    detected_company_type: null,
    expected_document_type: null,
    session_status: "active",
  });
  await onGreeting(await loadSession(session.id));
}

// Ask the dealer to choose a company type via tappable buttons. The typed
// fallback still works (onCompanyType also accepts free text), so dealers on
// clients that don't render buttons can reply with a word. Moves the session to
// ASK_COMPANY_TYPE and clears any leftover expected document.
export async function askCompanyType(
  session: SessionRow,
  prefix?: string,
): Promise<void> {
  const body =
    (prefix ? prefix + "\n\n" : "") +
    "What is your *company type*? Tap an option below 👇";
  await reply(session, body, COMPANY_TYPE_BUTTONS);
  await setSession(session.id, {
    current_state: "ASK_COMPANY_TYPE",
    expected_document_type: null,
  });
}

async function onCompanyType(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  // A button tap arrives as type "interactive" with the button id (a canonical
  // CompanyType) in event.text; a typed answer is parsed from free text.
  const ct =
    event.type === "interactive"
      ? asCompanyType(event.text)
      : event.type === "text"
        ? parseCompanyType(event.text ?? "")
        : null;
  if (!ct) {
    await askCompanyType(session, "Sorry, I didn't catch that.");
    return;
  }

  await mergeContext(session, (ctx) => {
    ctx.answers = { ...(ctx.answers ?? {}), companyType: ct };
  });
  await patchApplication(session.application_id, { company_type: ct });

  const firstDoc = requiredDocuments(ct)[0];
  await setSession(session.id, {
    current_state: "ASK_UPLOAD_MODE",
    detected_company_type: ct,
    expected_document_type: firstDoc.type,
  });

  // Confirmation + the document checklist, then the upload-method choice.
  await reply(
    session,
    `Great — *${humanCompanyType(ct)}*.\n\n${documentChecklistMessage(ct)}`,
  );
  await askUploadMode(session);
}

// Ask the dealer how they want to send the documents — all at once in a ZIP
// folder, or one at a time. Typed replies ("zip"/"one by one") also work for
// clients that don't render buttons.
async function askUploadMode(
  session: SessionRow,
  prefix?: string,
): Promise<void> {
  const body =
    (prefix ? prefix + "\n\n" : "") +
    "How would you like to send them? You can put *all documents in one folder (ZIP)* and upload together, or send them *one at a time*. 👇";
  await reply(session, body, UPLOAD_MODE_BUTTONS);
  await setSession(session.id, { current_state: "ASK_UPLOAD_MODE" });
}

async function onUploadMode(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  // If the dealer skipped the choice and just sent a file (or a ZIP), treat it
  // as a document upload straight away.
  if (event.mediaProviderId) {
    await setSession(session.id, { current_state: "COLLECTING_DOC" });
    return await onDocument(await loadSession(session.id), event);
  }

  const id = event.type === "interactive" ? (event.text ?? "") : "";
  const text = (event.text ?? "").toLowerCase();
  const wantsZip = id === "upload_zip" || /\b(zip|folder|all|together|batch)\b/.test(text);
  const wantsOne =
    id === "upload_one" || /\b(one|single|individual|by\s*one|ek)\b/.test(text);

  if (wantsZip) {
    await setSession(session.id, { current_state: "COLLECTING_DOC" });
    await reply(
      session,
      "📦 Great — please attach a *single .zip file* containing all the documents from the list above. I'll read them all and tell you if anything is missing or unclear.",
    );
    return;
  }

  if (wantsOne) {
    const ct = session.detected_company_type as CompanyType | null;
    const first = requiredDocuments(ct)[0];
    await setSession(session.id, {
      current_state: "COLLECTING_DOC",
      expected_document_type: first.type,
    });
    await reply(session, `📄 No problem — let's go one by one.\n\n${first.request}`);
    return;
  }

  await askUploadMode(session, "Please tap one of the options below.");
}

async function onDocument(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const ct = session.detected_company_type as CompanyType | null;
  const expected = session.expected_document_type;
  const spec = expected ? docSpec(ct, expected) : undefined;

  // ZIP / batch upload — a single archive holding many documents. Classify and
  // extract each, fill what we recognise, then ask only for what's still
  // missing. Handled before the single-document path below.
  if (event.mediaProviderId && isZipUpload(event)) {
    return await onZipUpload(session, event, ct);
  }

  // The dealer typed instead of sending a file. Before re-asking for the
  // document, handle a mid-flow company-type correction — a dealer who picked
  // the wrong type otherwise gets permanently stuck on the wrong checklist.
  if (!event.mediaProviderId) {
    const text = event.text ?? "";

    // Named a DIFFERENT company type → switch to it, keeping already-collected
    // documents (the common docs are shared across all entity types).
    const corrected = parseCompanyType(text);
    if (corrected && corrected !== ct) {
      await switchCompanyType(session, corrected);
      return;
    }

    // Signalled they want to change type but didn't name one → re-ask with the
    // selectable buttons.
    if (text && corrected === null && WANTS_TYPE_CHANGE.test(text)) {
      await askCompanyType(
        session,
        "No problem — let's set your company type again.",
      );
      return;
    }

    // "I have this only" / "move further" / "skip" / "done" → don't get stuck.
    // When a specific document is expected, mark it for manual admin follow-up;
    // when nothing specific is outstanding (e.g. after the ZIP "resend the file
    // I couldn't read" prompt), just proceed.
    if (text && SKIP_WORDS.test(text)) {
      if (expected) {
        await skipDoc(session, expected, spec?.label ?? expected);
      } else {
        await advanceDocument(session);
      }
      return;
    }

    await reply(
      session,
      expected
        ? `Please send a *photo or PDF*. ${spec?.request ?? ""}`.trim()
        : "Please resend the document as a *photo or PDF*, or reply *done* to continue.",
    );
    return;
  }

  // Any non-ZIP file → classify it. We store ONLY documents on this entity
  // type's required list (in their correct slot, even if sent out of order);
  // anything else is rejected without being stored.
  return await ingestClassifiedFile(session, event, ct);
}

// During dealer ONBOARDING, a proprietor's/partner's personal PAN doubles as the
// business PAN, and the owner's Aadhaar is the same physical card the customer-KYC
// console calls "aadhaar_front"/"aadhaar_back". The shared document classifier may
// tag these as the individual "pan_card"/"aadhaar_front"/"aadhaar_back" types,
// none of which are on the onboarding required list — so the dealer's own PAN or
// Aadhaar would be rejected as "not a required document". Alias them to the
// onboarding "company_pan"/"owner_aadhaar" slots. Applied ONLY on the onboarding
// ingest paths below; the customer console keeps the original types.
function normalizeOnboardingDocType(documentType: string): string {
  if (documentType === "pan_card") return "company_pan";
  if (documentType === "aadhaar_front" || documentType === "aadhaar_back") {
    return "owner_aadhaar";
  }
  return documentType;
}

// Classify an uploaded file and route it:
//   • unreadable / unidentifiable → don't store; ask to resend (auto-skip the
//     expected document after repeated bad tries so the dealer is never stuck);
//   • recognised but NOT a required document for this company type → reject and
//     DON'T store it (we keep only required documents), telling the dealer;
//   • required → store in its correct slot and advance.
// Serves both one-by-one collection and post-ZIP resends.
async function ingestClassifiedFile(
  session: SessionRow,
  event: InboundEvent,
  ct: CompanyType | null,
): Promise<void> {
  const expected = session.expected_document_type;
  const expectedSpec = expected ? docSpec(ct, expected) : undefined;

  const media = await getAdapter().downloadMedia(event.mediaProviderId!);
  const c = await classifyDocument(media.buffer, media.mimeType);
  // Dealer's personal PAN == company PAN for onboarding (see helper above).
  c.documentType = normalizeOnboardingDocType(c.documentType);

  // Couldn't read / identify → don't store; ask to resend.
  if (!c.ok || !c.legible || c.documentType === "unknown") {
    if (
      expected &&
      (await bumpAttempt(session, expected, expectedSpec?.label ?? expected)) === "skip"
    ) {
      return;
    }
    await reply(
      session,
      expectedSpec?.request
        ? `I couldn't read that clearly. ${expectedSpec.request}\n\n_If you don't have a clearer copy, reply *skip*._`
        : "I couldn't read that document clearly. Please resend a sharp *photo or PDF*, or reply *done* to continue.",
    );
    return;
  }

  // Recognised, but NOT one of the documents this company type needs → wrong
  // document. Tell the dealer and DON'T store it (we keep only required docs).
  if (!docSpec(ct, c.documentType)) {
    await reply(
      session,
      `⚠️ That looks like a *${docTypeLabel(c.documentType)}*, which isn't a required document for a *${humanCompanyType(ct)}*, so I won't store it.` +
        (expectedSpec?.request ? `\n\n${expectedSpec.request}` : ""),
    );
    return;
  }

  // Required → store in its correct slot (handles out-of-order uploads). No
  // automated verification here; values are dropped on the admin dashboard for
  // manual review (status 'pending').
  const spec = docSpec(ct, c.documentType);
  const saved = await saveMedia({
    buffer: media.buffer,
    mimeType: media.mimeType,
    applicationId: session.application_id!,
    docType: c.documentType,
    fileName: event.fileName,
  });
  await insertDocRow(session, c.documentType, saved, media.mimeType, {
    extraction: { fields: c.fields, confidence: c.confidence, isExpectedType: true },
    check: null,
    verificationStatus: "pending",
  });
  await fillFromDoc(session, c.documentType, c.fields);
  // Note: blank key fields are NOT re-asked here — a later document may supply
  // the value (cross-document fill); advanceDocument surfaces any still blank.
  await mergeContext(session, (ctx) => {
    ctx.docs = {
      ...(ctx.docs ?? {}),
      [c.documentType]: { fields: c.fields, confidence: c.confidence },
    };
  });

  const note =
    c.confidence < MIN_CONFIDENCE
      ? " (some values were hard to read — our team will double-check)"
      : "";
  await reply(session, `Got your *${spec?.label ?? c.documentType}* ✅${note}`);

  // Tell the admins a document landed. Deliberately only for a STORED required
  // document — the unreadable and wrong-document branches above return early,
  // and notifying on those would fill the bell with a dealer's failed retries.
  await notifyOnboardingDocsUploaded({
    phone: session.wa_phone,
    docLabel: spec?.label ?? c.documentType,
    businessName: session.wa_contact_name ?? null,
  });

  await advanceDocument(await loadSession(session.id));
}

// ── ZIP / batch upload ───────────────────────────────────────────────────────

// MIME types Meta reports for a .zip. Some Android clients send a generic
// octet-stream, so we ALSO accept any attachment whose filename ends in .zip.
const ZIP_MIMES = new Set([
  "application/zip",
  "application/x-zip",
  "application/x-zip-compressed",
  "multipart/x-zip",
]);

// Extension → MIME for files pulled out of the archive (Gemini needs a real
// media type). Anything not here is skipped (e.g. .docx, .txt, .DS_Store).
const ZIP_ENTRY_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
};

// Hard cap so a pathological archive can't fan out into hundreds of Gemini
// calls in one turn.
const MAX_ZIP_ENTRIES = 25;

function isZipUpload(event: InboundEvent): boolean {
  const mime = (event.mimeType ?? "").toLowerCase();
  if (ZIP_MIMES.has(mime)) return true;
  return (event.fileName ?? "").toLowerCase().endsWith(".zip");
}

type ZipEntry = { name: string; buffer: Buffer; mime: string };

// Pull every extractable image/PDF out of the archive. Skips directories,
// macOS resource forks (__MACOSX/…, dot-underscore files), and unsupported
// file types.
async function readZipEntries(buffer: Buffer): Promise<ZipEntry[]> {
  const zip = await JSZip.loadAsync(buffer);
  const entries: ZipEntry[] = [];
  const files = Object.values(zip.files);
  for (const f of files) {
    if (f.dir) continue;
    const base = f.name.split("/").pop() ?? f.name;
    if (f.name.startsWith("__MACOSX/") || base.startsWith(".")) continue;
    const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
    const mime = ZIP_ENTRY_MIME[ext];
    if (!mime) continue;
    entries.push({ name: base, buffer: await f.async("nodebuffer"), mime });
    if (entries.length >= MAX_ZIP_ENTRIES) break;
  }
  return entries;
}

async function onZipUpload(
  session: SessionRow,
  event: InboundEvent,
  ct: CompanyType | null,
): Promise<void> {
  await reply(
    session,
    "📦 Got your ZIP — reading all the documents now, one moment…",
  );

  // Download + unzip.
  let entries: ZipEntry[];
  try {
    const media = await getAdapter().downloadMedia(event.mediaProviderId!);
    entries = await readZipEntries(media.buffer);
  } catch (err) {
    console.error("[WhatsApp/orchestrator] zip read failed:", err);
    await reply(
      session,
      "I couldn't open that ZIP file. Please make sure it's a valid .zip and try again, or send the documents one by one.",
    );
    return;
  }

  if (entries.length === 0) {
    await reply(
      session,
      "That ZIP didn't contain any readable images or PDFs. Please send a ZIP of JPG/PNG/PDF files, or send each document one by one.",
    );
    return;
  }

  // READ — classify + extract every file IN PARALLEL (the slow part). Gemini
  // decides each file's type; we route required ones into the normal save/fill
  // path. DB writes that follow are applied sequentially to avoid races on the
  // session context / ownership snapshot.
  const classifications = await Promise.all(
    entries.map((e) => classifyDocument(e.buffer, e.mime)),
  );

  const accepted = new Map<string, string>(); // docType → label (last file wins)
  const unreadable: string[] = []; // couldn't read/identify → ask to resend
  const wrongDocs: string[] = []; // recognised but not required → not stored

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const c = classifications[i];

    // Genuinely couldn't read / identify it → ask the dealer to resend this one.
    if (!c.ok || !c.legible || c.documentType === "unknown") {
      unreadable.push(entry.name);
      continue;
    }

    // Dealer's personal PAN == company PAN for onboarding (see helper above).
    c.documentType = normalizeOnboardingDocType(c.documentType);

    const spec = docSpec(ct, c.documentType);

    // Recognised, but NOT a required document for this company type → wrong
    // document. We keep only required documents, so we DON'T store it.
    if (!spec) {
      wrongDocs.push(`${entry.name} (looks like ${docTypeLabel(c.documentType)})`);
      continue;
    }

    const saved = await saveMedia({
      buffer: entry.buffer,
      mimeType: entry.mime,
      applicationId: session.application_id!,
      docType: c.documentType,
      fileName: entry.name,
    });
    await insertDocRow(session, c.documentType, saved, entry.mime, {
      extraction: {
        fields: c.fields,
        confidence: c.confidence,
        isExpectedType: true,
      },
      check: null,
      verificationStatus: "pending",
    });
    await fillFromDoc(session, c.documentType, c.fields);
    await mergeContext(session, (ctx) => {
      ctx.docs = {
        ...(ctx.docs ?? {}),
        [c.documentType]: { fields: c.fields, confidence: c.confidence },
      };
    });
    accepted.set(c.documentType, spec.label);
  }

  // Recompute what's still outstanding (missing docs + blank key fields,
  // cross-document aware).
  const fresh = await loadSession(session.id);
  const freshCtx = (fresh.context ?? {}) as Ctx;
  const collected = freshCtx.docs ?? {};
  const issues = onboardingIssues(ct, collected, freshCtx.skipped ?? []);

  // Build the "what I got" summary message.
  const parts: string[] = [];
  if (accepted.size > 0) {
    parts.push(
      "✅ Received from your ZIP:\n" +
        [...accepted.values()].map((l) => `• ${l}`).join("\n"),
    );
  } else {
    parts.push("I went through your ZIP but couldn't match any of the required documents.");
  }
  if (unreadable.length > 0) {
    parts.push(
      "⚠️ I couldn't read these file(s):\n" +
        unreadable.map((n) => `• ${n}`).join("\n"),
    );
  }
  if (wrongDocs.length > 0) {
    parts.push(
      "🚫 These aren't required documents, so I didn't store them:\n" +
        wrongDocs.map((n) => `• ${n}`).join("\n"),
    );
  }
  await reply(session, parts.join("\n\n"));

  // Anything required still missing or blank → list it and re-ask for the first
  // one (a required document that failed to read shows up here as "missing").
  if (issues.missing.length || issues.blank.length) {
    await informIssues(session, issues);
    return;
  }

  // Required docs are all in, but one or more files were unreadable → ask the
  // dealer to resend those clearly before finishing. expected_document_type is
  // cleared so the resend is auto-classified (ingestClassifiedFile). "done" lets
  // them proceed if they don't need those files.
  if (unreadable.length > 0) {
    await setSession(session.id, {
      current_state: "COLLECTING_DOC",
      expected_document_type: null,
    });
    await reply(
      session,
      `Please resend ${unreadable.length === 1 ? "this file" : "these files"} clearly (a sharp *photo or PDF*) so I can read ${unreadable.length === 1 ? "it" : "them"}:\n` +
        unreadable.map((n) => `• ${n}`).join("\n") +
        `\n\nIf you don't need ${unreadable.length === 1 ? "it" : "them"}, reply *done* and I'll continue.`,
    );
    return;
  }

  // Everything's in and readable → move on to financing / submission.
  await reply(session, "That's everything I needed — thank you! ✅");
  await advanceDocument(await loadSession(session.id));
}

type OnboardingIssues = {
  /** Required documents not uploaded at all. */
  missing: DocSpec[];
  /** Uploaded documents whose key fields came back blank. */
  blank: { spec: DocSpec; fields: string[] }[];
};

// Is this key field present (non-blank) in ANY collected document? Extracted
// field keys are shared across document types (ifsc / account_number on both the
// bank statement and the cancelled cheque; pan on the PAN card and ITR), so a
// value missing on one document can be satisfied by another — as long as it's
// the SAME field, which keeps the cross-fill semantically related.
function resolvedAcrossDocs(
  collected: Record<string, { fields: Record<string, unknown> }>,
  key: string,
): boolean {
  return Object.values(collected).some((d) => !isBlankValue(d.fields?.[key]));
}

// Compute what's still outstanding for a company type, given the documents
// collected so far (ctx.docs) and the documents the dealer/admin chose to skip.
// A document is "missing" if not uploaded; "blank" only if a key field is empty
// here AND not supplied by any other document (cross-document fill). Skipped
// documents are never flagged — they move to manual admin follow-up.
function onboardingIssues(
  ct: CompanyType | null,
  collected: Record<string, { fields: Record<string, unknown> }>,
  skipped: string[] = [],
): OnboardingIssues {
  const skip = new Set(skipped);
  const missing: DocSpec[] = [];
  const blank: { spec: DocSpec; fields: string[] }[] = [];
  for (const spec of requiredDocuments(ct)) {
    if (skip.has(spec.type)) continue;
    const got = collected[spec.type];
    if (!got) {
      missing.push(spec);
      continue;
    }
    const b = blankKeyFields(spec.type, got.fields ?? {}).filter(
      (k) => !resolvedAcrossDocs(collected, k),
    );
    if (b.length) blank.push({ spec, fields: b });
  }
  return { missing, blank };
}

// Increment a document's failed-attempt counter; once it crosses the cap, skip
// the document (manual admin follow-up) and return "skip" so the caller stops
// re-asking. Otherwise returns "ask".
async function bumpAttempt(
  session: SessionRow,
  docType: string,
  label: string,
): Promise<"skip" | "ask"> {
  let count = 0;
  await mergeContext(session, (ctx) => {
    ctx.attempts = { ...(ctx.attempts ?? {}) };
    ctx.attempts[docType] = (ctx.attempts[docType] ?? 0) + 1;
    count = ctx.attempts[docType];
  });
  if (count >= MAX_DOC_ATTEMPTS) {
    await skipDoc(session, docType, label);
    return "skip";
  }
  return "ask";
}

// Mark a document as skipped (the dealer can't provide it, or we gave up after
// repeated bad uploads) and continue the flow so we never get stuck in one spot.
async function skipDoc(
  session: SessionRow,
  docType: string,
  label: string,
): Promise<void> {
  await mergeContext(session, (ctx) => {
    ctx.skipped = Array.from(new Set([...(ctx.skipped ?? []), docType]));
  });
  await reply(
    session,
    `No problem — we'll continue without the *${label}* for now. 👍\n\nWhenever you have it, just send it here on WhatsApp and our team will add it to your application.`,
  );
  await advanceDocument(await loadSession(session.id));
}

// Tell the dealer exactly what's still outstanding (missing docs + docs whose
// key fields couldn't be read) and re-ask for the first one. Used by the ZIP
// path and after the upload-method choice when documents are incomplete.
async function informIssues(
  session: SessionRow,
  issues: OnboardingIssues,
): Promise<void> {
  const lines = ["Before I can submit, I still need a few things:", ""];
  for (const d of issues.missing) {
    lines.push(`• *${d.label}* — not received yet`);
  }
  for (const b of issues.blank) {
    lines.push(
      `• *${b.spec.label}* — couldn't read the ${b.fields
        .map(fieldLabel)
        .join(", ")}; please resend a clearer copy`,
    );
  }
  const firstSpec = issues.missing[0] ?? issues.blank[0].spec;
  await setSession(session.id, {
    current_state: "COLLECTING_DOC",
    expected_document_type: firstSpec.type,
  });
  lines.push(
    "",
    firstSpec.request,
    "",
    "_If you don't have it, just reply *skip* and our team will follow up._",
  );
  await reply(session, lines.join("\n"));
}

// Move the flow forward. Missing documents are asked FIRST (so we don't nag
// about a blank field that a not-yet-uploaded document will supply); only once
// every required document is in do we surface any key field still blank across
// ALL of them. When nothing's outstanding, move on to financing. Recomputes
// from collected progress (not a fixed index), so already-collected and skipped
// documents are naturally skipped.
async function advanceDocument(session: SessionRow): Promise<void> {
  const ct = session.detected_company_type as CompanyType | null;
  const fresh = await loadSession(session.id);
  const ctx = (fresh.context ?? {}) as Ctx;
  const collected = ctx.docs ?? {};
  const issues = onboardingIssues(ct, collected, ctx.skipped ?? []);

  // Still have documents not uploaded → ask the next one. Don't mention blanks
  // yet; a later document may fill them.
  if (issues.missing.length) {
    const next = issues.missing[0];
    await setSession(session.id, {
      current_state: "COLLECTING_DOC",
      expected_document_type: next.type,
    });
    await reply(session, next.request);
    return;
  }

  // Every document is in, but a key value couldn't be read on any of them → ask
  // the dealer to resend that document, auto-skipping after a few tries.
  if (issues.blank.length) {
    const b = issues.blank[0];
    if ((await bumpAttempt(session, b.spec.type, b.spec.label)) === "skip") return;
    await setSession(session.id, {
      current_state: "COLLECTING_DOC",
      expected_document_type: b.spec.type,
    });
    await reply(
      session,
      `I still need the *${b.fields.map(fieldLabel).join(", ")}* — please resend your *${b.spec.label}* clearly so I can read ${b.fields.length > 1 ? "them" : "it"}.\n\n_If you don't have a clearer copy, reply *skip* and our team will follow up._`,
    );
    return;
  }

  // All documents collected and readable → ask the one decision not in any
  // document (financing), then submit. Owner/partner details are extracted from
  // the documents; any document-absent detail the admin needs is requested via
  // the correction loop (ASK_FIELD / onField stay in place for that admin flow).
  await setSession(session.id, { expected_document_type: null });
  await reply(session, "Thank you! I've received all your documents. ✅");
  await askFinance(await loadSession(session.id));
}

// Ask the financing Yes/No question with tappable buttons.
async function askFinance(
  session: SessionRow,
  prefix?: string,
): Promise<void> {
  const body =
    (prefix ? prefix + "\n\n" : "") +
    "Do you want *financing enabled* for your customers? Tap an option below 👇";
  await reply(session, body, FINANCE_BUTTONS);
  await setSession(session.id, { current_state: "ASK_FINANCE" });
}

// Capture the financing choice (drives the agreement flow) and submit.
async function onFinance(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const ans = financeAnswer(event);
  if (ans === null) {
    await askFinance(session, "Please tap *Yes* or *No*.");
    return;
  }
  await mergeContext(session, (c) => {
    c.answers = { ...(c.answers ?? {}), financeEnabled: ans };
  });
  await patchApplication(session.application_id, { finance_enabled: ans });
  // Final gate before submit: confirm the signer (owner) name/email/phone used
  // for the dealer agreement. Correct → submit; Change → re-enter those fields.
  await sendSignerConfirm(await loadSession(session.id));
}

// Switch the dealer's company type mid-collection (e.g. they realise they
// answered wrong). Documents already collected are kept — the common documents
// are identical across every entity type, so only the entity-specific extra
// document (Partnership Deed / MoA+AoA / none) differs. We resume at the first
// document the new checklist still needs, or move on if everything's already in.
async function switchCompanyType(
  session: SessionRow,
  ct: CompanyType,
): Promise<void> {
  await mergeContext(session, (ctx) => {
    ctx.answers = { ...(ctx.answers ?? {}), companyType: ct };
  });
  await patchApplication(session.application_id, { company_type: ct });

  const fresh = await loadSession(session.id);
  const collected = ((fresh.context ?? {}) as Ctx).docs ?? {};
  const docs = requiredDocuments(ct);
  const nextNeeded = docs.find((d) => !collected[d.type]);

  await reply(
    session,
    `Got it — I've updated your company type to *${humanCompanyType(ct)}*.\n\n${documentChecklistMessage(ct)}`,
  );

  if (nextNeeded) {
    await setSession(session.id, {
      current_state: "COLLECTING_DOC",
      detected_company_type: ct,
      expected_document_type: nextNeeded.type,
    });
    await reply(session, nextNeeded.request);
    return;
  }

  // Every document the new type requires is already collected → advance to the
  // typed questions. Park expected_document_type on the last doc so
  // advanceDocument finds no "next" and transitions to ASK_FIELD.
  await setSession(session.id, {
    current_state: "COLLECTING_DOC",
    detected_company_type: ct,
    expected_document_type: docs[docs.length - 1].type,
  });
  await advanceDocument(await loadSession(session.id));
}

async function onField(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const ctx = (session.context ?? {}) as Ctx;
  const idx = ctx.fieldIndex ?? 0;
  const field = ASK_FIELDS[idx];
  if (!field) {
    await sendSummary(session);
    return;
  }

  if (event.type !== "text" || !event.text?.trim()) {
    await reply(session, `Please type your answer. ${field.question}`);
    return;
  }

  const parsed = parseFieldValue(field.kind, event.text);
  if (parsed === null) {
    await reply(
      session,
      `That doesn't look right. ${field.question}`,
    );
    return;
  }

  await mergeContext(session, (c) => {
    c.answers = { ...(c.answers ?? {}), [field.key]: parsed };
    c.fieldIndex = idx + 1;
  });
  await patchApplication(session.application_id, fieldToColumn(field.key, parsed));

  const next = ASK_FIELDS[idx + 1];
  if (next) {
    await reply(session, next.question);
  } else {
    const fresh = await loadSession(session.id);
    await sendSummary(fresh);
  }
}

async function onConfirm(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const text = (event.text ?? "").trim();
  if (CONFIRM_WORDS.test(text) || text === "CONFIRM") {
    await submitToAdmin(session);
    return;
  }
  if (CHANGE_WORDS.test(text) || text === "CHANGE") {
    // Phase 1: re-ask the typed fields; document re-corrections go through the
    // Sales Admin "Ask Correction" loop after submission (design §14).
    await mergeContext(session, (ctx) => {
      ctx.fieldIndex = 0;
    });
    await setSession(session.id, { current_state: "ASK_FIELD" });
    await reply(
      session,
      "No problem — let's review your details again.",
    );
    const fresh = await loadSession(session.id);
    await reply(fresh, ASK_FIELDS[0].question);
    return;
  }
  await reply(
    session,
    "Please reply *CONFIRM* to submit, or *CHANGE* if something needs fixing.",
  );
}

// ── Signer (owner) confirmation before submit ────────────────────────────────
// The owner IS the dealer-agreement signer (name/email/phone drive the Digio
// e-sign), so the dealer explicitly confirms these before the application is
// submitted. Correct → submit; Change → re-enter only these three fields.

const SIGNER_FIELDS = ASK_FIELDS.filter((f) =>
  ["ownerName", "ownerPhone", "ownerEmail"].includes(f.key),
);

// Match the button id first; the typed fallbacks intentionally exclude the word
// "correct" from the change set (the global CHANGE_WORDS includes it).
const SIGNER_CORRECT_WORDS =
  /^(correct|confirm|confirmed|ok|okay|yes|yep|y|haan|ha|sahi|theek)$/i;
const SIGNER_CHANGE_WORDS = /^(change|edit|badlo|galat|wrong)$/i;

async function sendSignerConfirm(session: SessionRow): Promise<void> {
  const ctx = (session.context ?? {}) as Ctx;
  const answers = ctx.answers ?? {};

  // Owner details are EXTRACTED from the documents into the application columns
  // (owner_name/phone/email) — and updated there when the dealer taps "Change".
  // Read those; only fall back to anything captured in the chat context.
  let ownerName = str(answers.ownerName);
  let ownerEmail = str(answers.ownerEmail);
  let ownerPhone = str(answers.ownerPhone);
  if (session.application_id) {
    const [row] = await db
      .select({
        ownerName: dealerOnboardingApplications.owner_name,
        ownerEmail: dealerOnboardingApplications.owner_email,
        ownerPhone: dealerOnboardingApplications.owner_phone,
      })
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, session.application_id))
      .limit(1);
    if (row) {
      ownerName = ownerName || str(row.ownerName);
      ownerEmail = ownerEmail || str(row.ownerEmail);
      ownerPhone = ownerPhone || str(row.ownerPhone);
    }
  }

  const lines = [
    "Please confirm the *signer (owner)* for your dealer agreement:",
    "",
    `*Name:* ${ownerName || "—"}`,
    `*Email:* ${ownerEmail || "—"}`,
    `*Phone:* ${ownerPhone || "—"}`,
    "",
    "Tap *Correct* to submit, or *Change* to edit these.",
  ];
  await setSession(session.id, {
    current_state: "CONFIRM_SIGNER",
    session_status: "awaiting_confirmation",
  });
  const buttons: ReplyButton[] = [
    { id: "CORRECT", title: "Correct" },
    { id: "CHANGE", title: "Change" },
  ];
  await reply(session, lines.join("\n"), buttons);
}

async function onSignerConfirm(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const text = (event.text ?? "").trim();
  if (text === "CORRECT" || SIGNER_CORRECT_WORDS.test(text)) {
    await submitToAdmin(session);
    return;
  }
  if (text === "CHANGE" || SIGNER_CHANGE_WORDS.test(text)) {
    await sendSignerFieldChoice(session);
    return;
  }
  await reply(
    session,
    "Tap *Correct* to submit, or *Change* to edit the signer details.",
  );
}

// Map the "Change" field-picker button id (or a typed word) → signer field key.
function resolveSignerChoice(text: string): string | null {
  if (text === "EDIT_NAME") return "ownerName";
  if (text === "EDIT_EMAIL") return "ownerEmail";
  if (text === "EDIT_PHONE") return "ownerPhone";
  const t = text.trim().toLowerCase();
  if (/^(name|naam)$/.test(t)) return "ownerName";
  if (/^(email|e-?mail|mail)$/.test(t)) return "ownerEmail";
  if (/^(phone|mobile|number|no|contact)$/.test(t)) return "ownerPhone";
  return null;
}

// "Change" tapped on the signer confirmation → ask WHICH detail to change,
// offering Name / Email / Phone as buttons. The dealer edits only the one they
// pick (see onSignerChoice + the single-edit branch in onSignerField).
async function sendSignerFieldChoice(session: SessionRow): Promise<void> {
  await setSession(session.id, { current_state: "ASK_SIGNER_CHOICE" });
  const buttons: ReplyButton[] = [
    { id: "EDIT_NAME", title: "Name" },
    { id: "EDIT_EMAIL", title: "Email" },
    { id: "EDIT_PHONE", title: "Phone" },
  ];
  await reply(
    session,
    "No problem — which detail would you like to change?",
    buttons,
  );
}

// Dealer picked which signer detail to change. Point signerIndex at that field,
// flag a single-field edit, and ask just that one question.
async function onSignerChoice(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const text = (event.text ?? "").trim();
  const key = resolveSignerChoice(text);
  if (!key) {
    await reply(
      session,
      "Please tap *Name*, *Email*, or *Phone* to choose what to change.",
    );
    return;
  }
  const idx = SIGNER_FIELDS.findIndex((f) => f.key === key);
  if (idx < 0) {
    await sendSignerConfirm(session);
    return;
  }
  await mergeContext(session, (ctx) => {
    ctx.signerIndex = idx;
    ctx.signerSingleEdit = true;
  });
  await setSession(session.id, { current_state: "ASK_SIGNER_FIELD" });
  const fresh = await loadSession(session.id);
  await reply(fresh, SIGNER_FIELDS[idx].question);
}

// Re-collect ONLY the signer fields (name/phone/email) after a "Change" tap,
// then loop back to the signer confirmation. Mirrors onField but bounded to
// SIGNER_FIELDS and never re-asks the financing question.
async function onSignerField(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const ctx = (session.context ?? {}) as Ctx;
  const idx = ctx.signerIndex ?? 0;
  const single = ctx.signerSingleEdit === true;
  const field = SIGNER_FIELDS[idx];
  if (!field) {
    await sendSignerConfirm(session);
    return;
  }

  if (event.type !== "text" || !event.text?.trim()) {
    await reply(session, `Please type your answer. ${field.question}`);
    return;
  }

  const parsed = parseFieldValue(field.kind, event.text);
  if (parsed === null) {
    await reply(session, `That doesn't look right. ${field.question}`);
    return;
  }

  await mergeContext(session, (c) => {
    c.answers = { ...(c.answers ?? {}), [field.key]: parsed };
    c.signerIndex = idx + 1;
    if (single) c.signerSingleEdit = false;
  });
  await patchApplication(session.application_id, fieldToColumn(field.key, parsed));

  // Single-field edit (dealer picked one of Name/Email/Phone) → straight back
  // to the signer confirmation. Otherwise walk the remaining signer fields.
  if (single) {
    const fresh = await loadSession(session.id);
    await sendSignerConfirm(fresh);
    return;
  }

  const next = SIGNER_FIELDS[idx + 1];
  if (next) {
    await reply(session, next.question);
  } else {
    const fresh = await loadSession(session.id);
    await sendSignerConfirm(fresh);
  }
}

// ── Summary + submission ────────────────────────────────────────────────────

async function sendSummary(session: SessionRow): Promise<void> {
  const ctx = (session.context ?? {}) as Ctx;
  const docs = ctx.docs ?? {};
  const answers = ctx.answers ?? {};

  const gst = docs.gst?.fields ?? {};
  const pan = docs.company_pan?.fields ?? {};
  const bank = (docs.bank_statement?.fields ?? docs.cancelled_cheque?.fields ?? {}) as Record<
    string,
    unknown
  >;
  const collectedDocs = requiredDocuments(
    session.detected_company_type as CompanyType | null,
  )
    .filter((d) => docs[d.type])
    .map((d) => d.label);

  const lines = [
    "Please confirm your dealer onboarding details:",
    "",
    `*Company:* ${str(gst.legal_name) || str(gst.trade_name) || "—"}`,
    `*Company type:* ${humanCompanyType(session.detected_company_type as CompanyType)}`,
    `*GST:* ${maskGstin(str(gst.gstin))}`,
    `*PAN:* ${maskPan(str(pan.pan))}`,
    `*Bank:* ${str(bank.bank_name) || "—"}`,
    `*Account:* ${maskAccount(str(bank.account_number))}`,
    `*IFSC:* ${maskIfsc(str(bank.ifsc))}`,
    `*Owner:* ${str(answers.ownerName) || "—"}`,
    `*Mobile:* ${str(answers.ownerPhone) || "—"}`,
    `*Email:* ${str(answers.ownerEmail) || "—"}`,
    `*Financing:* ${answers.financeEnabled ? "Yes" : "No"}`,
    `*Documents received:* ${collectedDocs.join(", ") || "—"}`,
    "",
    "Reply *CONFIRM* to submit, or *CHANGE* if anything is wrong.",
  ];

  await setSession(session.id, {
    current_state: "AWAIT_CONFIRM",
    session_status: "awaiting_confirmation",
  });

  const buttons: ReplyButton[] = [
    { id: "CONFIRM", title: "Confirm" },
    { id: "CHANGE", title: "Change" },
  ];
  await reply(session, lines.join("\n"), buttons);
}

async function submitToAdmin(session: SessionRow): Promise<void> {
  const ctx = (session.context ?? {}) as Ctx;
  const now = new Date();
  await patchApplication(session.application_id, {
    onboarding_status: "submitted",
    review_status: "pending_admin_review",
    dealer_confirmed_at: now,
    submitted_at: now,
    extraction_summary: buildExtractionSummary(ctx),
  });
  await setSession(session.id, {
    current_state: "SUBMITTED",
    session_status: "submitted",
  });
  await reply(
    session,
    "✅ *Submitted!* Thank you. Our team will review your application and get back to you on WhatsApp shortly.",
  );
}

// ── In-chat correction (admin requested corrections; design §14) ─────────────

// Field-key → input kind for re-validation. Catalog keys not listed are text.
const CORRECTION_FIELD_KIND: Record<string, "text" | "phone" | "email"> = {
  ownerPhone: "phone",
  salesManagerMobile: "phone",
  ownerEmail: "email",
  salesManagerEmail: "email",
};

function correctionItemPrompt(
  ct: CompanyType | null,
  item: { kind: "field" | "document"; key: string },
): string {
  if (item.kind === "field") {
    return `✏️ Please send the corrected *${correctionFieldLabel(item.key)}*.`;
  }
  const waType = catalogDocToWhatsapp(item.key);
  const spec = waType ? docSpec(ct, waType) : undefined;
  return (
    `📄 Please re-upload your *${correctionDocumentLabel(item.key)}* as a photo or PDF.` +
    (spec?.request ? `\n\n${spec.request}` : "")
  );
}

/**
 * Move a WhatsApp dealer's session into CORRECTION mode and prompt the first
 * item. Called from the admin request-correction route (best-effort, gated on
 * source === "whatsapp"). Returns ok=false if the dealer has no session.
 */
export async function startCorrectionOverWhatsApp(params: {
  application: {
    id: string;
    wa_session_id: string | null;
    wa_phone: string | null;
    // E-214 — which channel currently owns the file, and the operator's own
    // per-dealer session. Optional so existing callers keep compiling.
    onboarding_channel?: string | null;
    wa_operator_session_id?: string | null;
  };
  roundId: string;
  roundNumber: number;
  remarks: string;
  requestedFields: string[]; // catalog field keys
  requestedDocuments: string[]; // catalog document keys
}): Promise<{ ok: boolean; error?: string }> {
  const { application, roundId, roundNumber, remarks } = params;

  // Locate the session that OWNS the file, so the correction lands in the chat
  // the documents actually came from. E-214: when the operator is uploading on
  // the dealer's behalf ('operator'), the dealer's own number may never have
  // messaged us — sending there would be a dead end.
  const preferredSessionId =
    application.onboarding_channel === "operator"
      ? (application.wa_operator_session_id ?? application.wa_session_id)
      : (application.wa_session_id ?? application.wa_operator_session_id ?? null);

  let session: SessionRow | undefined;
  if (preferredSessionId) {
    session = await loadSession(preferredSessionId);
  }
  if (!session && application.wa_phone) {
    // Phone fallback. Skip operator_file rows — they carry the OPERATOR's phone,
    // never the dealer's, so a match here would be the wrong conversation.
    const [row] = await db
      .select()
      .from(whatsappOnboardingSessions)
      .where(
        and(
          eq(whatsappOnboardingSessions.wa_phone, application.wa_phone),
          ne(whatsappOnboardingSessions.session_kind, "operator_file"),
        ),
      )
      .orderBy(desc(whatsappOnboardingSessions.created_at))
      .limit(1);
    session = row;
  }
  if (!session) return { ok: false, error: "no_session" };

  const queue: Array<{ kind: "field" | "document"; key: string }> = [
    ...params.requestedFields.map((key) => ({ kind: "field" as const, key })),
    ...params.requestedDocuments.map((key) => ({
      kind: "document" as const,
      key,
    })),
  ];
  if (queue.length === 0) return { ok: false, error: "empty_queue" };

  await mergeContext(session, (ctx) => {
    ctx.correction = { roundId, roundNumber, queue, index: 0 };
  });

  const first = queue[0];
  const firstWaType =
    first.kind === "document" ? catalogDocToWhatsapp(first.key) : null;
  await setSession(session.id, {
    current_state: "CORRECTION",
    session_status: "active",
    expected_document_type: firstWaType,
  });

  const fresh = await loadSession(session.id);
  const ct = fresh.detected_company_type as CompanyType | null;
  const itemList = queue
    .map(
      (it, i) =>
        `${i + 1}. ${it.kind === "field" ? correctionFieldLabel(it.key) : correctionDocumentLabel(it.key)}`,
    )
    .join("\n");
  const intro =
    `🔔 *Our team needs a few corrections* before we can approve your application.\n\n` +
    `*What the reviewer noted:* ${remarks}\n\n` +
    `Please fix these ${queue.length} item(s):\n${itemList}\n\nLet's start 👇`;
  await reply(fresh, intro);
  await reply(fresh, correctionItemPrompt(ct, first));
  return { ok: true };
}

async function onCorrection(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const ctx = (session.context ?? {}) as Ctx;
  const corr = ctx.correction;
  if (!corr || corr.index >= corr.queue.length) {
    await reply(
      session,
      "Your application is already submitted and under review. Our team will contact you shortly.",
    );
    return;
  }

  const ct = session.detected_company_type as CompanyType | null;
  const item = corr.queue[corr.index];

  if (item.kind === "field") {
    if (event.type !== "text" || !event.text?.trim()) {
      await reply(
        session,
        `Please type your answer. ${correctionItemPrompt(ct, item)}`,
      );
      return;
    }
    const kind = CORRECTION_FIELD_KIND[item.key] ?? "text";
    const parsed = parseFieldValue(kind, event.text);
    if (parsed === null) {
      await reply(
        session,
        `That doesn't look right. ${correctionItemPrompt(ct, item)}`,
      );
      return;
    }
    await db
      .update(dealerCorrectionItems)
      .set({ new_value: String(parsed) })
      .where(
        and(
          eq(dealerCorrectionItems.round_id, corr.roundId),
          eq(dealerCorrectionItems.kind, "field"),
          eq(dealerCorrectionItems.key, item.key),
        ),
      );
    await advanceCorrection(session);
    return;
  }

  // Document item — require an attachment, then ingest as pending_correction.
  if (!event.mediaProviderId) {
    await reply(
      session,
      `Please send a *photo or PDF*. ${correctionItemPrompt(ct, item)}`,
    );
    return;
  }
  const ok = await ingestCorrectionDoc(session, event, item.key, corr.roundId, ct);
  if (ok) await advanceCorrection(session);
}

/** Advance to the next queued correction item, or finalize the round. */
async function advanceCorrection(session: SessionRow): Promise<void> {
  const fresh = await loadSession(session.id);
  const ctx = (fresh.context ?? {}) as Ctx;
  const corr = ctx.correction;
  if (!corr) return;

  const nextIndex = corr.index + 1;
  if (nextIndex >= corr.queue.length) {
    await finalizeCorrection(fresh, corr.roundId);
    return;
  }

  await mergeContext(fresh, (c) => {
    if (c.correction) c.correction.index = nextIndex;
  });
  const next = corr.queue[nextIndex];
  const nextWaType =
    next.kind === "document" ? catalogDocToWhatsapp(next.key) : null;
  await setSession(fresh.id, { expected_document_type: nextWaType });
  const ct = fresh.detected_company_type as CompanyType | null;
  await reply(fresh, correctionItemPrompt(ct, next));
}

async function finalizeCorrection(
  session: SessionRow,
  roundId: string,
): Promise<void> {
  // Mirror the web correction submit: mark the round submitted; do NOT mutate
  // the application — the admin's apply-correction step does that.
  await db
    .update(dealerCorrectionRounds)
    .set({
      status: "submitted",
      dealer_submitted_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(dealerCorrectionRounds.id, roundId));
  await setSession(session.id, {
    current_state: "SUBMITTED",
    session_status: "submitted",
    expected_document_type: null,
  });
  await reply(
    session,
    "✅ *Thank you!* Your corrections have been submitted. Our team will review them and get back to you on WhatsApp shortly.",
  );
}

/**
 * Download + store a re-uploaded correction document as a pending_correction
 * row, then link it to its correction item via new_document_id. Returns false
 * (and asks the dealer to resend) if unreadable. Does NOT touch the original
 * LIVE document — apply-correction supersedes that later by id.
 */
async function ingestCorrectionDoc(
  session: SessionRow,
  event: InboundEvent,
  catalogKey: string,
  roundId: string,
  ct: CompanyType | null,
): Promise<boolean> {
  const waType = catalogDocToWhatsapp(catalogKey) ?? catalogKey;
  const media = await getAdapter().downloadMedia(event.mediaProviderId!);
  const c = await classifyDocument(media.buffer, media.mimeType);

  if (!c.ok || !c.legible || c.documentType === "unknown") {
    await reply(
      session,
      `I couldn't read that clearly. Please resend your *${correctionDocumentLabel(catalogKey)}* as a sharp *photo or PDF*.`,
    );
    return false;
  }

  const saved = await saveMedia({
    buffer: media.buffer,
    mimeType: media.mimeType,
    applicationId: session.application_id!,
    docType: waType,
    fileName: event.fileName,
  });

  const [inserted] = await db
    .insert(dealerOnboardingDocuments)
    .values({
      application_id: session.application_id!,
      document_type: waType,
      bucket_name: saved.bucket,
      storage_path: saved.path,
      file_name: saved.fileName,
      file_url: saved.fileUrl,
      mime_type: media.mimeType,
      file_size: saved.fileSize,
      doc_status: "pending_correction",
      verification_status: "pending",
      extracted_data: c.fields as any,
      metadata: {
        confidence: c.confidence,
        collected_via: "whatsapp",
        source: "dealer_correction_submission",
        correction_round_id: roundId,
      } as any,
      source: "whatsapp",
      extraction_engine: "gemini",
      extraction_confidence: String(c.confidence),
    })
    .returning({ id: dealerOnboardingDocuments.id });

  await db
    .update(dealerCorrectionItems)
    .set({ new_document_id: inserted.id })
    .where(
      and(
        eq(dealerCorrectionItems.round_id, roundId),
        eq(dealerCorrectionItems.kind, "document"),
        eq(dealerCorrectionItems.key, catalogKey),
      ),
    );

  const spec = docSpec(ct, waType);
  await reply(
    session,
    `Got your *${spec?.label ?? correctionDocumentLabel(catalogKey)}* ✅`,
  );
  return true;
}

// ── DB helpers ──────────────────────────────────────────────────────────────

/**
 * The conversation row for an inbound number.
 *
 * E-214: `operator_file` rows are EXCLUDED from the lookup. They carry the
 * operator's own wa_phone (so replies reach them) but belong to a specific
 * dealer file; without this filter the newest-by-created_at pick would hand the
 * operator's next message to whichever dealer file they opened last instead of
 * their menu hub. Every pre-E-214 row defaults to session_kind='dealer', so no
 * existing number changes behaviour.
 *
 * `operator` is passed when the sender is on the internal allowlist: they get a
 * bare `operator_hub` row with NO placeholder application — an operator saying
 * "hi" is not a dealer walking in the door.
 */
async function getOrCreateSession(
  event: InboundEvent,
  operator?: WhatsAppOperator | null,
): Promise<SessionRow> {
  const existing = await db
    .select()
    .from(whatsappOnboardingSessions)
    .where(
      and(
        eq(whatsappOnboardingSessions.wa_phone, event.waPhone),
        ne(whatsappOnboardingSessions.session_kind, "operator_file"),
      ),
    )
    .orderBy(desc(whatsappOnboardingSessions.created_at))
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0];
    // A number that used to onboard as a DEALER has just been allowlisted as an
    // operator. Promote its existing row to the hub rather than leaving a
    // `dealer` row driving the OP_* states: the partial unique index and every
    // `session_kind` filter (admin pipeline, handoff lookup, listOpenFiles) key
    // off this column, so an unpromoted row would be invisible to them. The old
    // application stays on disk; showOperatorMenu clears the pointer to it.
    if (operator && row.session_kind !== "operator_hub") {
      await db
        .update(whatsappOnboardingSessions)
        .set({
          session_kind: "operator_hub",
          operator_id: operator.id,
          updated_at: new Date(),
        })
        .where(eq(whatsappOnboardingSessions.id, row.id));
      return { ...row, session_kind: "operator_hub", operator_id: operator.id };
    }
    return row;
  }

  if (operator) {
    try {
      const [hub] = await db
        .insert(whatsappOnboardingSessions)
        .values({
          wa_phone: event.waPhone,
          wa_contact_name: event.contactName ?? operator.displayName,
          provider: getAdapter().provider,
          provider_conversation_id: event.conversationId ?? null,
          application_id: null,
          session_kind: "operator_hub",
          operator_id: operator.id,
          current_state: "OP_MENU",
          session_status: "active",
          last_inbound_at: new Date(),
        })
        .returning();
      return hub;
    } catch (err) {
      // whatsapp_onboarding_sessions_operator_hub_key (partial UNIQUE) — two
      // near-simultaneous first messages raced. getOrCreateSession is a
      // deliberately unlocked read-then-insert, so re-select the winner.
      const [hub] = await db
        .select()
        .from(whatsappOnboardingSessions)
        .where(
          and(
            eq(whatsappOnboardingSessions.wa_phone, event.waPhone),
            eq(whatsappOnboardingSessions.session_kind, "operator_hub"),
          ),
        )
        .limit(1);
      if (hub) return hub;
      throw err;
    }
  }

  // New conversation → create a draft application + session. company_name is
  // NOT NULL, so seed a placeholder; it's overwritten once the GST is read.
  const [application] = await db
    .insert(dealerOnboardingApplications)
    .values({
      company_name: PLACEHOLDER_COMPANY,
      source: "whatsapp",
      wa_phone: event.waPhone,
      onboarding_status: "draft",
      review_status: "draft",
      agreement_status: "not_generated",
      stamp_status: "pending",
      completion_status: "pending",
    })
    .returning();

  const [session] = await db
    .insert(whatsappOnboardingSessions)
    .values({
      wa_phone: event.waPhone,
      wa_contact_name: event.contactName ?? null,
      provider: getAdapter().provider,
      provider_conversation_id: event.conversationId ?? null,
      application_id: application.id,
      current_state: "GREETING",
      session_status: "active",
      last_inbound_at: new Date(),
    })
    .returning();

  await db
    .update(dealerOnboardingApplications)
    .set({ wa_session_id: session.id })
    .where(eq(dealerOnboardingApplications.id, application.id));

  // A brand-new WhatsApp onboarding conversation. Fires once per session, on
  // creation — the only signal iTarang gets that a dealer has walked in the
  // WhatsApp door, since there is no form submission until the very end.
  await notifyOnboardingChatStarted({
    phone: event.waPhone,
    sessionId: session.id,
  });

  return session;
}

// Merge extracted values into provider_raw_response.submissionSnapshot.ownership
// — the JSON blob the admin Dealer-Validation page reads for the "Owner
// Residential Address" and bank extras (branch, account type). These have no
// dedicated columns, so document-extracted values must land here to surface on
// the dashboard. Read-modify-write; only non-empty keys are written so a later
// document never nulls out a value an earlier one filled.
async function mergeOwnershipSnapshot(
  applicationId: string | null,
  patch: Record<string, unknown>,
  opts: { fillOnly?: boolean } = {},
): Promise<void> {
  if (!applicationId) return;
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v != null && v !== ""),
  );
  if (Object.keys(clean).length === 0) return;

  const [row] = await db
    .select({ raw: dealerOnboardingApplications.provider_raw_response })
    .from(dealerOnboardingApplications)
    .where(eq(dealerOnboardingApplications.id, applicationId))
    .limit(1);

  let raw: Record<string, any> = {};
  const rawVal = row?.raw as unknown;
  if (typeof rawVal === "string") {
    try { raw = JSON.parse(rawVal); } catch { raw = {}; }
  } else if (rawVal && typeof rawVal === "object") {
    raw = rawVal as Record<string, any>;
  }

  const snapshot =
    raw.submissionSnapshot && typeof raw.submissionSnapshot === "object"
      ? (raw.submissionSnapshot as Record<string, any>)
      : {};
  const ownership =
    snapshot.ownership && typeof snapshot.ownership === "object"
      ? (snapshot.ownership as Record<string, any>)
      : {};

  // fillOnly = a fallback source: only set keys the snapshot doesn't already
  // have, so a weaker document (GST/Udyam address) never overwrites a stronger
  // one (bank statement holder address) regardless of document order.
  const toApply = opts.fillOnly
    ? Object.fromEntries(
        Object.entries(clean).filter(([k]) => {
          const cur = ownership[k];
          return cur == null || cur === "";
        }),
      )
    : clean;
  if (Object.keys(toApply).length === 0) return;

  const merged = {
    ...raw,
    submissionSnapshot: {
      ...snapshot,
      ownership: { ...ownership, ...toApply },
    },
  };

  await db
    .update(dealerOnboardingApplications)
    .set({ provider_raw_response: merged as any, updated_at: new Date() })
    .where(eq(dealerOnboardingApplications.id, applicationId));
}

// Write the whole `gstAddresses` object into submissionSnapshot. Unlike the
// ownership merge (per-key fill), this replaces the object wholesale — during
// onboarding the admin hasn't tagged roles yet, so latest GST read wins. Any
// existing role tags by id are preserved so a re-read doesn't reset the admin's
// billing/dispatch choices.
async function setGstAddressesSnapshot(
  applicationId: string | null,
  gstAddresses: Record<string, any>,
): Promise<void> {
  if (!applicationId) return;

  const [row] = await db
    .select({ raw: dealerOnboardingApplications.provider_raw_response })
    .from(dealerOnboardingApplications)
    .where(eq(dealerOnboardingApplications.id, applicationId))
    .limit(1);

  let raw: Record<string, any> = {};
  const rawVal = row?.raw as unknown;
  if (typeof rawVal === "string") {
    try { raw = JSON.parse(rawVal); } catch { raw = {}; }
  } else if (rawVal && typeof rawVal === "object") {
    raw = rawVal as Record<string, any>;
  }

  const snapshot =
    raw.submissionSnapshot && typeof raw.submissionSnapshot === "object"
      ? (raw.submissionSnapshot as Record<string, any>)
      : {};

  // Preserve any role tags an earlier value carried (keyed by stable id).
  const prev = snapshot.gstAddresses as Record<string, any> | undefined;
  if (prev) {
    const prevRoles = new Map<string, unknown>();
    if (prev.principal?.id) prevRoles.set(prev.principal.id, prev.principal.roles);
    for (const a of Array.isArray(prev.additional) ? prev.additional : []) {
      if (a?.id) prevRoles.set(a.id, a.roles);
    }
    if (prevRoles.has(gstAddresses.principal?.id))
      gstAddresses.principal.roles = prevRoles.get(gstAddresses.principal.id);
    for (const a of gstAddresses.additional ?? []) {
      if (prevRoles.has(a.id)) a.roles = prevRoles.get(a.id);
    }
  }

  const merged = {
    ...raw,
    submissionSnapshot: { ...snapshot, gstAddresses },
  };

  await db
    .update(dealerOnboardingApplications)
    .set({ provider_raw_response: merged as any, updated_at: new Date() })
    .where(eq(dealerOnboardingApplications.id, applicationId));
}

async function insertDocRow(
  session: SessionRow,
  docType: string,
  saved: { bucket: string; path: string; fileUrl: string; fileName: string; fileSize: number },
  mimeType: string,
  opts: {
    extraction: { fields: Record<string, unknown>; confidence: number; isExpectedType: boolean };
    check: { provider: string; raw: unknown } | null;
    verificationStatus: string;
  },
): Promise<void> {
  // Dedupe: dealers frequently re-send the same document several times. Keep
  // only the latest copy per (application, document_type) — delete prior LIVE
  // rows AND their storage objects before inserting this one, so we store (and
  // the admin sees) exactly one fresh document per type. Superseded /
  // pending_correction rows belong to the correction-round history, so they're
  // left untouched.
  const priorRows = await db
    .select({
      id: dealerOnboardingDocuments.id,
      bucket: dealerOnboardingDocuments.bucket_name,
      path: dealerOnboardingDocuments.storage_path,
    })
    .from(dealerOnboardingDocuments)
    .where(
      and(
        eq(dealerOnboardingDocuments.application_id, session.application_id!),
        eq(dealerOnboardingDocuments.document_type, docType),
        notInArray(dealerOnboardingDocuments.doc_status, [
          "superseded",
          "pending_correction",
        ]),
      ),
    );
  if (priorRows.length) {
    await db
      .delete(dealerOnboardingDocuments)
      .where(inArray(dealerOnboardingDocuments.id, priorRows.map((r) => r.id)));
    const byBucket = new Map<string, string[]>();
    for (const r of priorRows) {
      if (!r.path) continue;
      const arr = byBucket.get(r.bucket) ?? [];
      arr.push(r.path);
      byBucket.set(r.bucket, arr);
    }
    for (const [bucket, paths] of byBucket) await removeMedia(bucket, paths);
  }

  await db.insert(dealerOnboardingDocuments).values({
    application_id: session.application_id!,
    document_type: docType,
    bucket_name: saved.bucket,
    storage_path: saved.path,
    file_name: saved.fileName,
    file_url: saved.fileUrl,
    mime_type: mimeType,
    file_size: saved.fileSize,
    doc_status: "uploaded",
    verification_status: opts.verificationStatus,
    extracted_data: opts.extraction.fields as any,
    api_verification_results: (opts.check?.raw ?? {}) as any,
    metadata: {
      confidence: opts.extraction.confidence,
      is_expected_type: opts.extraction.isExpectedType,
      collected_via: "whatsapp",
    } as any,
    source: "whatsapp",
    extraction_engine: "gemini",
    extraction_confidence: String(opts.extraction.confidence),
    verification_provider: opts.check?.provider ?? null,
  });
}

// ── FILL: map extracted fields onto application columns ──────────────────────

async function fillFromDoc(
  session: SessionRow,
  docType: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const ct = session.detected_company_type as CompanyType | null;
  const patch: Record<string, unknown> = {};
  switch (docType) {
    case "gst": {
      if (str(fields.gstin)) patch.gst_number = str(fields.gstin);
      // Company name = the TRADE name (the business), preferring it over the
      // legal name. For a sole proprietorship the GST legal name is the
      // PROPRIETOR (a person) — using it as the company name shows the dealer's
      // own name in the Company field. The trade name is the real business name.
      if (str(fields.trade_name) || str(fields.legal_name)) {
        patch.company_name = str(fields.trade_name) || str(fields.legal_name);
      }
      // GST Principal + every Additional Place of Business → address cards the
      // admin tags as billing/dispatch/other. Stored in the snapshot (no column).
      const gstAddresses = buildGstAddresses(fields);
      await setGstAddressesSnapshot(
        session.application_id,
        gstAddresses as unknown as Record<string, any>,
      );
      // Also persist the GST Principal Place of Business into the
      // `business_address` column so the admin "Company Address" field is
      // populated for WhatsApp dealers. Web onboarding writes this column on
      // submit; the WhatsApp path previously wrote ONLY the gstAddresses
      // snapshot, so Company Address always showed "MISSING". Shape mirrors the
      // admin extractAddress() reader: {"address": "…"}.
      const principal = gstAddresses.principal;
      const fullAddress =
        principal.raw ||
        [
          principal.addressLine1,
          principal.city,
          principal.district,
          principal.state,
          principal.pincode,
        ]
          .filter(Boolean)
          .join(", ");
      if (fullAddress) {
        patch.business_address = JSON.stringify({
          address: fullAddress,
          city: principal.city,
          state: principal.state,
          pincode: principal.pincode,
        });
      }
      // For a sole proprietorship the GST legal name IS the proprietor — use it
      // as the owner name. Udyam (read later) overrides if it carries one.
      if (ct === "sole_proprietorship" && str(fields.legal_name)) {
        patch.owner_name = str(fields.legal_name);
        // GST principal address → owner residential address FALLBACK (the bank
        // statement, read later, overrides if it carries a holder address).
        await mergeOwnershipSnapshot(
          session.application_id,
          ownerAddressFromFields(fields),
          { fillOnly: true },
        );
      }
      break;
    }
    case "company_pan":
      if (str(fields.pan)) patch.pan_number = str(fields.pan);
      break;
    case "owner_aadhaar": {
      // E-175 — store the owner's 12-digit Aadhaar; matched against the Digio
      // signer Aadhaar at agreement signing (sync-signers.ts).
      const a = str(fields.aadhaar_number).replace(/\D/g, "");
      if (a.length === 12) patch.owner_aadhaar_no = a;
      break;
    }
    case "bank_statement":
    case "cancelled_cheque": {
      if (str(fields.bank_name)) patch.bank_name = str(fields.bank_name);
      if (str(fields.account_number)) patch.account_number = str(fields.account_number);
      if (str(fields.ifsc)) patch.ifsc_code = str(fields.ifsc);
      if (str(fields.account_holder_name)) patch.beneficiary_name = str(fields.account_holder_name);
      // Bank branch + account type, and (for a sole proprietorship) the account
      // holder's address as the owner residential address. These have no columns
      // — they live in the ownership snapshot the admin page reads.
      // Account type: normalise the extracted label ('SB'/'CA'/'Savings' → the
      // canonical word). We store ONLY what the bank document actually printed —
      // if it didn't state a type (cheques and many statements don't), leave it
      // blank rather than inferring from the holder name, so the admin review
      // page flags it as "Not available / Missing".
      const accountType = normalizeAccountType(str(fields.account_type));
      const ownership: Record<string, unknown> = {
        branch: str(fields.branch),
        accountType,
      };
      // Bank statement holder address is the PRIMARY owner residential address
      // (overrides any GST/Udyam fallback already written).
      if (ct === "sole_proprietorship") {
        Object.assign(ownership, ownerAddressFromFields(fields));
      }
      await mergeOwnershipSnapshot(session.application_id, ownership);
      break;
    }
    case "udyam":
      // Udyam carries the entrepreneur's contact details — the authoritative
      // owner info. Only set fields actually present so we never null out a
      // value already filled from another document.
      if (str(fields.owner_name)) patch.owner_name = str(fields.owner_name);
      if (str(fields.owner_mobile)) patch.owner_phone = str(fields.owner_mobile);
      if (str(fields.owner_email)) patch.owner_email = str(fields.owner_email);
      // Udyam enterprise name → company name FALLBACK. Only fills when we don't
      // already have a real business name (placeholder, empty, or identical to
      // the owner), so a GST trade name read earlier is never clobbered.
      if (str(fields.enterprise_name)) {
        const [cur] = await db
          .select({
            companyName: dealerOnboardingApplications.company_name,
            ownerName: dealerOnboardingApplications.owner_name,
          })
          .from(dealerOnboardingApplications)
          .where(eq(dealerOnboardingApplications.id, session.application_id!))
          .limit(1);
        const curName = (cur?.companyName || "").trim();
        const ownerNm = (cur?.ownerName || "").trim();
        if (
          !curName ||
          curName === PLACEHOLDER_COMPANY ||
          curName.toLowerCase() === ownerNm.toLowerCase()
        ) {
          patch.company_name = str(fields.enterprise_name);
        }
      }
      // Udyam enterprise address → owner residential address FALLBACK (only
      // fills if neither the bank statement nor GST supplied one).
      if (ct === "sole_proprietorship") {
        await mergeOwnershipSnapshot(
          session.application_id,
          ownerAddressFromFields(fields),
          { fillOnly: true },
        );
      }
      break;
    case "partnership_deed":
      // Partnership deed / LLP agreement → first partner as the owner name. All
      // partner names stay visible to the admin via the extraction summary.
      if (Array.isArray(fields.partner_names) && fields.partner_names.length) {
        const first = str(fields.partner_names[0]);
        if (first) patch.owner_name = first;
      }
      break;
    default:
      break;
  }
  await patchApplication(session.application_id, patch);
}

function fieldToColumn(key: string, value: unknown): Record<string, unknown> {
  switch (key) {
    case "ownerName":
      return { owner_name: value };
    case "ownerPhone":
      return { owner_phone: value };
    case "ownerEmail":
      return { owner_email: value };
    case "financeEnabled":
      return { finance_enabled: Boolean(value) };
    default:
      return {};
  }
}

function buildExtractionSummary(ctx: Ctx): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [docType, d] of Object.entries(ctx.docs ?? {})) {
    summary[docType] = { fields: d.fields, confidence: d.confidence };
  }
  if (ctx.answers) summary.answers = ctx.answers;
  return summary;
}

// ── Misc helpers ────────────────────────────────────────────────────────────
// (reply / replyList / loadSession / setSession / mergeContext / patchApplication
//  now live in ./session-store — see the import block at the top of this file.)

function parseFieldValue(
  kind: "text" | "phone" | "email" | "yesno",
  raw: string,
): unknown | null {
  const v = raw.trim();
  switch (kind) {
    case "text":
      return v.length > 0 ? v : null;
    case "phone": {
      const digits = v.replace(/\D/g, "");
      return digits.length >= 10 ? digits : null;
    }
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v.toLowerCase() : null;
    case "yesno":
      if (/^(yes|y|haan|ha|ji|jee|हाँ|हां|जी)$/i.test(v)) return true;
      if (/^(no|n|nahi|nahin|नहीं|नही|na)$/i.test(v)) return false;
      return null;
    default:
      return null;
  }
}

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

// Map a document's structured address fields → the ownership-snapshot owner
// residential address keys the admin page reads.
function ownerAddressFromFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ownerAddressLine1: str(fields.address_line1),
    ownerCity: str(fields.city),
    ownerDistrict: str(fields.district),
    ownerState: str(fields.state),
    ownerPinCode: str(fields.pincode),
  };
}

function humanCompanyType(ct: CompanyType | null): string {
  switch (ct) {
    case "sole_proprietorship":
      return "Sole Proprietorship";
    case "partnership_firm":
      return "Partnership Firm";
    case "private_limited_firm":
      return "Private Limited";
    case "llp":
      return "LLP";
    default:
      return "—";
  }
}

// ── Post-approval dealer console (DC_* states) ───────────────────────────────
// Once a dealer's onboarding application is admin-approved, their WhatsApp
// number drives this menu-based console instead of the onboarding flow. The
// "New Lead" path is built end-to-end (capture → consent → documents); the other
// menu items are stubs for now.

// A greeting / "menu" in the console always returns the dealer to the main menu.
const CONSOLE_MENU_TRIGGERS =
  /^(hi+|hey+|hello+|helo|hii+|menu|start|home|back|namaste)$/i;

const DEALER_MENU_ROWS: ListRow[] = [
  { id: "menu_new_lead", title: "🆕 New Lead", description: "Create a new customer lead" },
  { id: "menu_drafts", title: "📝 Save Drafts", description: "Resume a saved lead" },
  { id: "menu_inventory", title: "📦 Inventory", description: "View available stock" },
  { id: "menu_active", title: "🔋 Active batteries", description: "Dispatched & sold — owner, warranty" },
  { id: "menu_help", title: "❓ Help", description: "Support & how it works" },
];

const INTEREST_BUTTONS: ReplyButton[] = [
  { id: "interest_hot", title: "🔥 Hot" },
  { id: "interest_warm", title: "🌤 Warm" },
  { id: "interest_cold", title: "❄ Cold" },
];

const PAYMENT_BUTTONS: ReplyButton[] = [
  { id: "pay_finance", title: "iTarang Finance" },
  { id: "pay_cash", title: "Cash" },
  { id: "pay_other", title: "Other Finance" },
];

// Cash-only dealers (dealers.finance_enabled = false) must never be offered a
// finance path. The web lead route enforces this server-side via the E-105 gate
// (FINANCE_NOT_ENABLED in /api/leads/create), but the WhatsApp console writes
// leads directly through customer-lead.ts and so bypasses that route — without
// this the buttons offered financing to every approved dealer regardless.
const CASH_ONLY_PAYMENT_BUTTONS: ReplyButton[] = [
  { id: "pay_cash", title: "Cash" },
];

function paymentButtons(dealer: ActiveDealer): ReplyButton[] {
  return dealer.financeEnabled ? PAYMENT_BUTTONS : CASH_ONLY_PAYMENT_BUTTONS;
}

function paymentPrompt(dealer: ActiveDealer): string {
  return dealer.financeEnabled
    ? "*Payment method*\n\nHow will the customer pay? Tap an option 👇"
    : "*Payment method*\n\nHow will the customer pay? Tap an option 👇\n\n" +
        "_Financing isn't enabled on your account yet, so leads are cash only. " +
        "Contact iTarang if you'd like to offer financing._";
}

function paymentRetryPrompt(dealer: ActiveDealer): string {
  return dealer.financeEnabled
    ? "Please tap *iTarang Finance*, *Cash* or *Other Finance*."
    : "Financing isn't enabled on your account, so this lead can only be *Cash*. " +
        "Please tap *Cash*, or contact iTarang to enable financing.";
}

/** One turn for an admin-approved dealer (the post-onboarding console). */
export async function runConsoleTurn(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  try {
    const text = (event.text ?? "").trim();
    // A typed greeting / "menu" is an escape back to the main menu — EXCEPT
    // mid-journey, where it used to be quietly destructive. showDealerMenu
    // clears ctx.lead, and the menu offers no way back into a submitted lead
    // (Save Drafts lists kyc_status='draft' only), so one "hi" while choosing a
    // lender or a battery stranded the application for good. A bare greeting in
    // a tap-driven step now re-renders that step instead.
    //
    // "menu"/"home"/"back" still escape. They are unambiguous requests to
    // leave, and a customer who genuinely wants out must not be trapped in a
    // step that keeps re-sending itself.
    if (event.type === "text" && CONSOLE_MENU_TRIGGERS.test(text)) {
      const journey = leadStateHandler(session.current_state);
      if (
        journey &&
        rerendersOnGreeting(session.current_state) &&
        !EXPLICIT_ESCAPE.test(text) &&
        leadIdOf(session)
      ) {
        return await journey(session, event, dealer);
      }
      return await showDealerMenu(session, dealer);
    }

    switch (session.current_state) {
      case "DC_MENU":
        return await onMenuChoice(session, event, dealer);
      case "DC_DRAFTS":
        return await onDraftSelection(session, event, dealer);
      case DC_ACTIVE_BATT:
        return await onActiveBatteryPick(session, event, dealer);
      case "DC_LEAD_MOBILE":
        return await onLeadMobile(session, event);
      case "DC_LEAD_INTEREST":
        return await onLeadInterest(session, event, dealer);
      case "DC_LEAD_PAYMENT":
        return await onLeadPayment(session, event, dealer);
      case "DC_LEAD_PRODUCT":
        return await onLeadProduct(session, event, dealer);
      case "DC_LEAD_DOCS_MODE":
        return await onLeadDocsMode(session, event, dealer);
      case "DC_LEAD_DOCS":
        return await onLeadDocs(session, event, dealer);
      case "DC_LEAD_CONSENT_CHANNEL":
        return await onConsentChannel(session, event, dealer);
      case "DC_LEAD_CONSENT_WAIT":
        return await onConsentWait(session, event);
      case "DC_LEAD_CONSENT_OTP_WAIT":
        return await onConsentOtpWait(session, event, dealer);
      case "DC_LEAD_FINANCE_Q":
        return await onLeadFinanceQuestion(session, event);
      case "DC_LEAD_CONSENT_REVIEW":
        return await onConsentReview(session, event);
      default: {
        // E-264 — journey phases (co-borrower, Step 4, offers, dispatch) register
        // their states in ./lead-states rather than adding cases here, so the
        // dealer and customer entry points cannot drift apart. One clause, and
        // every phase is reachable from both.
        const handler = leadStateHandler(session.current_state);
        if (handler) return await handler(session, event, dealer);
        // Any other state (an onboarding-terminal state, or a stale DC_* not yet
        // handled) drops the dealer back to the menu.
        return await showDealerMenu(session, dealer);
      }
    }
  } catch (err) {
    console.error("[WhatsApp/console] turn failed:", err);
    await reply(
      session,
      "Sorry, something went wrong on our side. Please send *menu* to start again.",
    );
  }
}

async function showDealerMenu(
  session: SessionRow,
  dealer: ActiveDealer,
): Promise<void> {
  const parked = await parkCurrentLead(session, dealer);
  await mergeContext(session, (ctx) => {
    ctx.lead = undefined;
  });
  await setSession(session.id, { current_state: "DC_MENU" });
  await replyList(
    session,
    (parked ? `${parkedNotice(parked)}\n\n` : "") +
      `👋 Hi *${dealer.dealerName}*!\n\nWhat would you like to do?`,
    "Open Menu",
    DEALER_MENU_ROWS,
  );
}

/** Console states that are NOT a customer onboarding in progress. */
const NOT_A_LEAD_STATE = new Set(["DC_MENU", "DC_DRAFTS", DC_ACTIVE_BATT]);

/**
 * Save whatever customer onboarding this chat is in the middle of, so that
 * starting another one (or going to the menu) never loses it.
 *
 * Two cases:
 *   - the lead row already exists (anything from the payment step onwards):
 *     it is already what Save Drafts lists — nothing to write, just say so.
 *   - only a mobile (and maybe an interest) has been typed: no row exists yet,
 *     so one is created now as an unclassified draft. `resumeDraft` picks it up
 *     at the first unanswered question and `classifyCustomerLead` fills the
 *     rest in when the dealer gets there.
 *
 * Returns the parked draft's display label, or null when nothing was in
 * progress. Never throws — losing the menu to a failed save would be worse
 * than losing the save.
 */
async function parkCurrentLead(
  session: SessionRow,
  dealer: ActiveDealer,
): Promise<string | null> {
  try {
    const fresh = await loadSession(session.id);
    if (NOT_A_LEAD_STATE.has(fresh.current_state)) return null;
    const lead = ((fresh.context as Ctx)?.lead ?? {}) as NonNullable<Ctx["lead"]>;

    if (lead.leadId) {
      const draft = await getDealerDraft(dealer.dealerCode, lead.leadId);
      if (draft) return draftLabel(draft);
      // Past the pre-submit draft states (co-borrower, lender pick, offers,
      // dispatch). The DB cannot rebuild where the chat was, so snapshot the
      // exact step + sub-context into ctx.parked; Save Drafts lists it from
      // there and resumeParkedJourney restores it verbatim.
      if (!leadStateHandler(fresh.current_state)) return null;
      const summary = await getDealerLeadSummary(dealer.dealerCode, lead.leadId);
      if (!summary) return null;
      const state = fresh.current_state;
      await mergeContext(session, (ctx) => {
        ctx.parked = {
          ...(ctx.parked ?? {}),
          [lead.leadId as string]: { state, lead, at: new Date().toISOString() },
        };
      });
      console.log(`[WhatsApp/console] parked journey ${lead.leadId} at ${state}`);
      return draftLabel(summary);
    }
    if (!lead.mobile) return null;

    const leadId = await createCustomerLead({
      dealer,
      mobile: lead.mobile,
      interest: lead.interest,
      notify: false,
    });
    console.log(`[WhatsApp/console] parked unclassified lead ${leadId} for ${lead.mobile}`);
    return lead.mobile;
  } catch (err) {
    console.error("[WhatsApp/console] park lead failed:", err);
    return null;
  }
}

function draftLabel(d: DealerDraft): string {
  return d.hasName ? `${d.customerName} (${d.mobile})` : d.mobile;
}

function parkedNotice(label: string): string {
  return `📝 *${label}* is saved in *Save Drafts* — you can pick it up where you left off any time.`;
}

async function onMenuChoice(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  const id = (event.text ?? "").trim();
  switch (id) {
    case "menu_new_lead":
      return await startNewLead(session, dealer);
    case "menu_drafts":
      return await showDrafts(session, dealer);
    case "menu_inventory":
      return await showInventory(session, dealer);
    case "menu_active":
      return await showActiveBatteries(session, dealer);
    case "menu_help":
      await reply(session, consoleHelpText());
      return;
    default:
      // Unrecognized free text while at the menu → re-show the menu.
      return await showDealerMenu(session, dealer);
  }
}

function consoleHelpText(): string {
  return [
    "❓ *iTarang Dealer Help*",
    "",
    "• Send *menu* any time to see your options.",
    "• *New Lead* — create a customer lead step by step.",
    "• *Save Drafts* — resume a lead you started earlier, right where you left it. Starting a new lead or sending *menu* mid-way saves the current one here automatically.",
    "• *Inventory* — see your available stock.",
    "• *Active batteries* — batteries you've dispatched, with owner and warranty.",
    "• Need a person? Email support@itarang.com.",
  ].join("\n");
}

// ── Console: Save Drafts (resume an unsubmitted lead) ─────────────────────────

/** Clip a string to `max` chars (WhatsApp list title ≤24 / description ≤72). */
function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}

/** Secondary line for a draft list row: mobile · interest · payment. */
function draftRowDescription(d: DealerDraft): string {
  const parts: string[] = [];
  if (d.mobile && d.mobile !== "—") parts.push(d.mobile);
  if (d.interest) parts.push(titleCase(d.interest));
  if (d.paymentMethod) parts.push(humanPayment(d.paymentMethod));
  return clip(parts.join(" · ") || "Saved lead", 72);
}

// Show the dealer's unsubmitted WhatsApp leads as a tappable list. Tapping one
// resumes it at the next incomplete step (onDraftSelection → resumeDraft).
/** Human label for the journey phase a parked lead is sitting in. */
function phaseLabel(state: string): string {
  if (state.startsWith("DC_CB_")) return "Co-borrower";
  if (state.startsWith("DC_S4_")) return "Lender selection";
  if (state.startsWith("DC_OF_")) return "Offers";
  if (state.startsWith("DC_DP_")) return "Dispatch";
  if (state.startsWith("DC_DOCREQ_")) return "Documents requested";
  if (state.startsWith("DC_XD_")) return "Extra documents";
  return "In progress";
}

type DraftListItem = DealerDraft & { parkedState?: string };

/**
 * Pre-submit drafts from the DB plus journeys parked mid-way in this chat
 * (ctx.parked). A parked lead that has since been finished elsewhere (sold,
 * closed) is dropped — getDealerLeadSummary still finds it, but its phase
 * handler decides what to say. Newest activity first, ≤10 rows (WhatsApp cap).
 */
async function listAllDrafts(
  session: SessionRow,
  dealer: ActiveDealer,
): Promise<DraftListItem[]> {
  const drafts: DraftListItem[] = await listDealerDrafts(dealer.dealerCode);
  const seen = new Set(drafts.map((d) => d.leadId));
  const fresh = await loadSession(session.id);
  const parked = ((fresh.context as Ctx)?.parked ?? {}) as NonNullable<Ctx["parked"]>;
  for (const [leadId, snap] of Object.entries(parked)) {
    if (seen.has(leadId)) continue;
    const summary = await getDealerLeadSummary(dealer.dealerCode, leadId);
    if (!summary) continue;
    drafts.push({
      ...summary,
      updatedAt: new Date(snap.at),
      parkedState: snap.state,
    });
  }
  drafts.sort(
    (a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0),
  );
  return drafts.slice(0, 10);
}

async function showDrafts(
  session: SessionRow,
  dealer: ActiveDealer,
): Promise<void> {
  const drafts = await listAllDrafts(session, dealer);
  if (drafts.length === 0) {
    await setSession(session.id, { current_state: "DC_MENU" });
    await reply(
      session,
      "📝 You don't have any saved drafts right now.\n\nTap *New Lead* from the menu to start one. Send *menu* to go back.",
    );
    return;
  }
  const rows: ListRow[] = drafts.map((d) => ({
    id: `draft_${d.leadId}`,
    title: clip(d.customerName, 24),
    description: d.parkedState
      ? clip(`${draftRowDescription(d)} · ${phaseLabel(d.parkedState)}`, 72)
      : draftRowDescription(d),
  }));
  await setSession(session.id, { current_state: "DC_DRAFTS" });
  await replyList(
    session,
    `📝 *Your saved drafts* (${drafts.length})\n\nTap a lead to resume it 👇`,
    "View drafts",
    rows,
  );
}

async function onDraftSelection(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  const id = (event.text ?? "").trim();
  if (!id.startsWith("draft_")) {
    // Anything other than a draft tap → re-show the list.
    return await showDrafts(session, dealer);
  }
  const leadId = id.slice("draft_".length);
  const draft = await getDealerDraft(dealer.dealerCode, leadId);
  if (draft) return await resumeDraft(session, dealer, draft);

  const fresh = await loadSession(session.id);
  const snap = ((fresh.context as Ctx)?.parked ?? {})[leadId];
  if (snap) return await resumeParkedJourney(session, dealer, leadId, snap);

  await reply(
    session,
    "I couldn't find that draft — it may have been submitted already. Send *menu* to go back.",
  );
  return await showDealerMenu(session, dealer);
}

/**
 * Pick a parked post-submit journey back up: restore the lead sub-context and
 * the exact state, then re-render that step. Phases that registered a `resume`
 * renderer use it; tap-driven steps re-render on a synthetic greeting (the same
 * path a typed "hi" takes); anything else just gets a nudge.
 */
async function resumeParkedJourney(
  session: SessionRow,
  dealer: ActiveDealer,
  leadId: string,
  snap: NonNullable<Ctx["parked"]>[string],
): Promise<void> {
  const summary = await getDealerLeadSummary(dealer.dealerCode, leadId);
  await mergeContext(session, (ctx) => {
    ctx.lead = { ...snap.lead, leadId };
    if (ctx.parked) delete ctx.parked[leadId];
  });
  await setSession(session.id, { current_state: snap.state });
  await reply(
    session,
    `▶️ Resuming *${summary ? draftLabel(summary) : leadId}* — ${phaseLabel(snap.state)}.`,
  );

  const live = await loadSession(session.id);
  const resumer = leadStateResumer(snap.state);
  if (resumer) return await resumer(live, dealer);

  const handler = leadStateHandler(snap.state);
  if (handler && rerendersOnGreeting(snap.state)) {
    return await handler(
      live,
      {
        providerMessageId: `resume:${leadId}:${Date.now()}`,
        waPhone: session.wa_phone,
        type: "text",
        text: "hi",
      },
      dealer,
    );
  }
  await reply(session, "Please reply to the last question above to continue.");
}

// Reverse of toKycDocType: map a stored kyc_documents.doc_type back to the
// WhatsApp customer doc type, or null if it isn't one of the required ones.
function fromKycDocType(kycType: string): string | null {
  const wa =
    kycType === "passport_photo"
      ? "customer_photo"
      : kycType === "cheque_1"
        ? "cancelled_cheque"
        : kycType;
  return (ACCEPTED_CUSTOMER_DOCS as readonly string[]).includes(wa) ? wa : null;
}

/** Rebuild the in-context customer-doc set for a lead from kyc_documents, so a
 *  resumed draft knows which documents are already in. */
async function loadCustomerDocsAsCtx(
  leadId: string,
): Promise<Record<string, true>> {
  const rows = await db
    .select({ docType: kycDocuments.doc_type })
    .from(kycDocuments)
    .where(
      and(eq(kycDocuments.lead_id, leadId), eq(kycDocuments.doc_for, "customer")),
    );
  const docs: Record<string, true> = {};
  for (const r of rows) {
    const wa = fromKycDocType(r.docType);
    if (wa) docs[wa] = true;
  }
  return docs;
}

/** True once all three post-consent finance answers are recorded on the lead. */
async function financeQuestionsAnswered(leadId: string): Promise<boolean> {
  const [row] = await db
    .select({
      resident: leads.resident_status,
      health: leads.has_health_insurance,
      life: leads.has_life_insurance,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!row) return false;
  return !!row.resident && row.health !== null && row.life !== null;
}

// Resume a draft: rehydrate ctx.lead and jump to the earliest incomplete step.
//   Hot + finance: documents → consent → finance questions → submit.
//   Anything else: nothing left to capture on WhatsApp (finished on the portal).
async function resumeDraft(
  session: SessionRow,
  dealer: ActiveDealer,
  draft: DealerDraft,
): Promise<void> {
  const docs = await loadCustomerDocsAsCtx(draft.leadId);
  await mergeContext(session, (ctx) => {
    if (ctx.parked) delete ctx.parked[draft.leadId];
    ctx.lead = {
      leadId: draft.leadId,
      mobile: draft.mobile,
      customerName: draft.customerName,
      interest: draft.interest ?? undefined,
      paymentMethod: draft.paymentMethod ?? undefined,
      docs,
    };
  });

  const { interest, paymentMethod } = draft;

  await reply(session, `▶️ Resuming *${draftLabel(draft)}*.`);

  // 0) Parked before it was classified → the first unanswered question.
  if (!interest) {
    await setSession(session.id, { current_state: "DC_LEAD_INTEREST" });
    await reply(
      session,
      "*Lead Classification*\n_Lead interest level_\n\nTap the customer's interest level 👇",
      INTEREST_BUTTONS,
    );
    return;
  }
  if (!paymentMethod) {
    await setSession(session.id, { current_state: "DC_LEAD_PAYMENT" });
    await reply(session, paymentPrompt(dealer), paymentButtons(dealer));
    return;
  }

  // Cash: name → vehicle reg → battery picker, whichever is next.
  if (paymentMethod === "cash") {
    const cash = await import("./cash-flow");
    if (!draft.hasName) return await cash.startCashSale(session);
    if (!draft.vehicleRc) return await cash.askVehicleRc(session);
    const { askBattery } = await import("./dispatch-flow");
    return await askBattery(await loadSession(session.id), draft.leadId, dealer, 0);
  }

  // Warm/cold finance has no further WhatsApp steps.
  if (!requiresConsent(interest, paymentMethod)) {
    await setSession(session.id, { current_state: "DC_MENU" });
    await reply(
      session,
      `📄 *${draft.customerName}* — ${humanPayment(paymentMethod)} lead is saved.\n\n` +
        "There's nothing more to capture here; finish the remaining steps on the dealer portal. Send *menu* to go back.",
    );
    return;
  }

  // Hot finance: product → documents → consent → finance questions → submit.
  if (!draft.productTagged) {
    await startProductStep(await loadSession(session.id), dealer);
    return;
  }

  // 1) Documents incomplete → back to the documents step.
  if (!REQUIRED_CUSTOMER_DOCS.every((d) => docs[d])) {
    await startDocs(session);
    return;
  }

  // 2) Documents in, consent not signed yet → re-issue the consent.
  const signed = await getSignedConsentForLead(draft.leadId);
  if (!signed.signed) {
    await reply(
      session,
      "Documents are all in. Now let's get the customer's *KYC consent*. Generating the consent form…",
    );
    await startConsent(await loadSession(session.id), dealer, draft.leadId);
    return;
  }

  // 3) Consent signed → resume the finance questions, or go straight to submit.
  if (!(await financeQuestionsAnswered(draft.leadId))) {
    await startFinanceQuestions(await loadSession(session.id));
    return;
  }
  await promptSubmitToITarang(await loadSession(session.id));
}

// ── Console: Inventory (available stock) ─────────────────────────────────────

async function showInventory(
  session: SessionRow,
  dealer: ActiveDealer,
): Promise<void> {
  const { rows, totalAvailable } = await getDealerAvailableStock(
    dealer.dealerCode,
  );
  await setSession(session.id, { current_state: "DC_MENU" });

  if (rows.length === 0) {
    await reply(
      session,
      "📦 You have no available stock right now.\n\nSend *menu* to go back.",
    );
    return;
  }

  // Group the per-product rows by category for a tidy summary.
  const byCategory = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byCategory.get(r.category) ?? [];
    list.push(r);
    byCategory.set(r.category, list);
  }

  const lines: string[] = ["📦 *Available Inventory*", ""];
  for (const [category, items] of byCategory) {
    lines.push(`*${titleCase(category)}*`);
    for (const it of items) {
      lines.push(`• ${clip(it.label, 40)} — *${it.available}*`);
    }
    lines.push("");
  }
  lines.push(`*Total available units:* ${totalAvailable}`);
  lines.push("", "Send *menu* to go back.");
  await reply(session, lines.join("\n"));
}

async function startNewLead(
  session: SessionRow,
  dealer: ActiveDealer,
): Promise<void> {
  const parked = await parkCurrentLead(session, dealer);
  await mergeContext(session, (ctx) => {
    ctx.lead = {};
  });
  await setSession(session.id, { current_state: "DC_LEAD_MOBILE" });
  await reply(
    session,
    (parked ? `${parkedNotice(parked)}\n\n` : "") +
      "🆕 *New Lead*\n\nPlease enter the *customer's mobile number* (10 digits).",
  );
}

async function onLeadMobile(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const mobile =
    event.type === "text" ? normalizeMobile(event.text ?? "") : null;
  if (!mobile) {
    await reply(
      session,
      "That doesn't look right. Please enter the customer's *10-digit mobile number*.",
    );
    return;
  }

  // NOTE: the "number already used for finance" check is NOT done here — at this
  // point we don't yet know if the lead is cash or finance, and cash leads have
  // no such restriction. It runs in onLeadPayment, gated on finance methods.
  // Customer self-onboarding (a new number onboarding itself, flow === "customer")
  // does NOT get asked to classify the lead — it defaults to "hot" and skips
  // straight to payment. The onboarded-dealer console (flow undefined) still asks
  // the Hot/Warm/Cold classification, since the dealer is qualifying the lead.
  const isCustomerFlow = ((session.context ?? {}) as Ctx).flow === "customer";
  if (isCustomerFlow) {
    await mergeContext(session, (ctx) => {
      ctx.lead = { ...(ctx.lead ?? {}), mobile, interest: "hot" };
    });
    // We deliberately don't ask the customer to type their name — it's extracted
    // from the PAN / Aadhaar in the documents step (fillCustomerLeadFromDoc), so
    // we go straight to the payment method.
    await setSession(session.id, { current_state: "DC_LEAD_PAYMENT" });
    await reply(
      session,
      "Got it ✅\n\n*Payment method*\n\nHow will the customer pay? Tap an option 👇",
      PAYMENT_BUTTONS,
    );
    return;
  }

  await mergeContext(session, (ctx) => {
    ctx.lead = { ...(ctx.lead ?? {}), mobile };
  });
  // We deliberately don't ask the dealer to type the customer's name — it's
  // extracted from the PAN / Aadhaar in the documents step
  // (fillCustomerLeadFromDoc), so we go straight to the interest level.
  await setSession(session.id, { current_state: "DC_LEAD_INTEREST" });
  await reply(
    session,
    "Got it ✅\n\n*Lead Classification*\n_Lead interest level_\n\nTap the customer's interest level 👇",
    INTEREST_BUTTONS,
  );
}

function parseInterest(event: InboundEvent): InterestLevel | null {
  const t = (event.text ?? "").trim().toLowerCase();
  if (event.type === "interactive") {
    if (t === "interest_hot") return "hot";
    if (t === "interest_warm") return "warm";
    if (t === "interest_cold") return "cold";
  }
  if (/\bhot\b/.test(t)) return "hot";
  if (/\bwarm\b/.test(t)) return "warm";
  if (/\bcold\b/.test(t)) return "cold";
  return null;
}

async function onLeadInterest(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  const interest = parseInterest(event);
  if (!interest) {
    await reply(
      session,
      "Please tap one of *Hot*, *Warm* or *Cold*.",
      INTEREST_BUTTONS,
    );
    return;
  }
  await mergeContext(session, (ctx) => {
    ctx.lead = { ...(ctx.lead ?? {}), interest };
  });
  // A resumed parked draft already has a row — keep it in step with the chat.
  const parkedId = ((session.context as Ctx)?.lead ?? {}).leadId;
  if (parkedId) await classifyCustomerLead(parkedId, dealer, { interest });
  await setSession(session.id, { current_state: "DC_LEAD_PAYMENT" });
  await reply(session, paymentPrompt(dealer), paymentButtons(dealer));
}

/**
 * Parse the dealer's payment choice. A cash-only dealer (finance not enabled)
 * is never shown the finance buttons, but the free-text branch below would
 * still match a typed "finance" — so finance choices resolve to null for them
 * and the caller re-prompts. This is the WhatsApp-side equivalent of the
 * FINANCE_NOT_ENABLED gate in /api/leads/create.
 */
function parsePayment(
  event: InboundEvent,
  financeEnabled: boolean,
): PaymentMethod | null {
  const t = (event.text ?? "").trim().toLowerCase();
  let picked: PaymentMethod | null = null;

  if (event.type === "interactive") {
    if (t === "pay_finance") picked = "finance";
    else if (t === "pay_cash") picked = "cash";
    else if (t === "pay_other") picked = "other_finance";
  }
  if (!picked) {
    if (/other/.test(t)) picked = "other_finance";
    else if (/itarang|finance/.test(t)) picked = "finance";
    else if (/cash/.test(t)) picked = "cash";
  }

  if (!financeEnabled && picked !== "cash") return null;
  return picked;
}

async function onLeadPayment(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  const paymentMethod = parsePayment(event, dealer.financeEnabled);
  if (!paymentMethod) {
    await reply(session, paymentRetryPrompt(dealer), paymentButtons(dealer));
    return;
  }

  const fresh = await loadSession(session.id);
  const draft = ((fresh.context as Ctx)?.lead ?? {}) as NonNullable<Ctx["lead"]>;
  if (!draft.mobile || !draft.interest) {
    // Context lost (e.g. server restart mid-flow) — restart cleanly.
    await reply(session, "Let's start over.");
    return await startNewLead(session, dealer);
  }

  // NOTE: no mobile-number duplicate check. The SAME mobile may be reused (cash
  // or finance). For FINANCE, uniqueness is enforced on the customer's DOCUMENTS
  // instead (PAN / Aadhaar) during the KYC documents step (DC_LEAD_DOCS).

  // Create the lead now so consent + documents can key off a real lead id. The
  // customer name is stored as a placeholder and filled from the PAN / Aadhaar
  // once the documents are read (fillCustomerLeadFromDoc).
  //
  // A draft parked before this step already HAS a row (see parkCurrentLead);
  // classify that one instead of inserting a second lead for the same customer.
  let leadId = draft.leadId;
  if (leadId) {
    await classifyCustomerLead(leadId, dealer, {
      interest: draft.interest,
      paymentMethod,
    });
  } else {
    leadId = await createCustomerLead({
      dealer,
      mobile: draft.mobile,
      interest: draft.interest,
      paymentMethod,
    });
  }
  await mergeContext(session, (ctx) => {
    ctx.lead = { ...(ctx.lead ?? {}), paymentMethod, leadId };
  });

  // CASH SKIPS EVERYTHING ELSE. A cash sale is a counter transaction: no
  // lender, no KYC to verify, no admin approval. It goes straight to
  // name → vehicle reg → pick a battery from live stock → SOLD (./cash-flow).
  // In particular it skips the product-CATEGORY tag below, because the cash
  // flow picks a real serial a moment later and tagging a category first would
  // ask the same question twice.
  if (paymentMethod === "cash") {
    const { startCashSale } = await import("./cash-flow");
    return await startCashSale(session);
  }

  // Finance leads capture *product details* next (DC_LEAD_PRODUCT). The
  // payment-specific steps run afterwards in afterProductStep():
  //   • hot finance → KYC documents → consent
  //   • warm/cold finance → save (finish on the portal)
  await startProductStep(session, dealer);
}

function humanPayment(p: PaymentMethod): string {
  return p === "finance"
    ? "iTarang Finance"
    : p === "other_finance"
      ? "Other Finance"
      : "Cash";
}

// ── Console: product details (all leads) → cash extras (reg + Aadhaar) ───────

const PRODUCT_PICK_PREFIX = "prod_";

/** DC_LEAD_PRODUCT — show the dealer's available products as a tappable list.
 *  With no available stock, skip straight to the payment-specific step. */
async function startProductStep(
  session: SessionRow,
  dealer: ActiveDealer,
): Promise<void> {
  const options = await getDealerProductOptions(dealer.dealerCode);
  if (options.length === 0) {
    // The house dealer (customer flow) never has stock, so skip the
    // dealer-oriented "set it on the portal" note and just continue.
    const fresh = await loadSession(session.id);
    if (((fresh.context as Ctx)?.flow) !== "customer") {
      await reply(
        session,
        "_No available stock to attach right now — you can set the product on the dealer portal._",
      );
    }
    return await afterProductStep(session);
  }

  const top = options.slice(0, 10); // WhatsApp lists allow ≤10 rows.
  await mergeContext(session, (ctx) => {
    if (!ctx.lead) ctx.lead = {};
    ctx.lead.productOptions = top.map((o) => ({
      productId: o.productId,
      categoryId: o.categoryId,
      name: o.name,
      assetType: o.assetType,
    }));
  });

  const rows: ListRow[] = top.map((o, i) => ({
    id: `${PRODUCT_PICK_PREFIX}${i}`,
    title: clip(o.name, 24),
    description: clip(`${o.assetType ?? "Product"} · ${o.available} in stock`, 72),
  }));
  await setSession(session.id, { current_state: "DC_LEAD_PRODUCT" });
  await replyList(
    session,
    "*Product details*\n\nWhich product is this lead for? Tap one 👇",
    "Choose product",
    rows,
  );
}

/** DC_LEAD_PRODUCT — resolve the tapped product, write it to the lead, continue. */
async function onLeadProduct(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  const fresh = await loadSession(session.id);
  const draft = ((fresh.context as Ctx)?.lead ?? {}) as NonNullable<Ctx["lead"]>;
  const opts = draft.productOptions ?? [];
  const id = (event.text ?? "").trim();
  const idx = id.startsWith(PRODUCT_PICK_PREFIX)
    ? Number(id.slice(PRODUCT_PICK_PREFIX.length))
    : NaN;
  const picked = Number.isInteger(idx) ? opts[idx] : undefined;
  if (!picked || !draft.leadId) {
    await reply(session, "Please tap a product from the list above.");
    return;
  }
  await setLeadProduct(draft.leadId, picked);
  await mergeContext(session, (ctx) => {
    if (ctx.lead) ctx.lead.productOptions = undefined;
  });
  await afterProductStep(session);
}

/**
 * Route by payment method once the product is chosen.
 *
 * Finance-only now: the cash branch moved up into onLeadPayment, which is why
 * this no longer takes a dealer.
 */
async function afterProductStep(session: SessionRow): Promise<void> {
  const fresh = await loadSession(session.id);
  const draft = ((fresh.context as Ctx)?.lead ?? {}) as NonNullable<Ctx["lead"]>;
  const interest = (draft.interest ?? "cold") as InterestLevel;
  const paymentMethod = (draft.paymentMethod ?? "cash") as PaymentMethod;

  // Cash forks earlier now, in onLeadPayment — it never reaches the product
  // step. This branch remains only for a lead whose draft says cash but which
  // somehow got here (a resumed session from before the change).
  if (paymentMethod === "cash") {
    const { startCashSale } = await import("./cash-flow");
    return await startCashSale(session);
  }

  // Hot finance → KYC documents → consent.
  if (requiresConsent(interest, paymentMethod)) {
    await reply(
      session,
      `✅ *Product saved.*\n\n` +
        `This is a *Hot* finance lead, so we'll need the customer's *KYC documents* ` +
        `and then their *consent*.\n\nLet's start with the documents 👇`,
    );
    await startDocs(session);
    return;
  }

  // Warm / cold finance → save; finish on the portal (dealer) or thank the
  // customer (customer flow).
  if (((fresh.context as Ctx)?.flow) === "customer") {
    return await finishCustomerFlow(
      session,
      `✅ *Thanks — we've saved your request!*\n\n` +
        `Mobile: ${draft.mobile ?? "—"}\n` +
        `Interest: ${interest}\n` +
        `Payment: ${humanPayment(paymentMethod)}\n\n` +
        `Our team will contact you shortly.`,
    );
  }
  await setSession(session.id, { current_state: "DC_MENU" });
  await reply(
    session,
    `✅ *Lead saved!*\n\n` +
      `Mobile: ${draft.mobile ?? "—"}\n` +
      `Interest: ${interest}\n` +
      `Payment: ${humanPayment(paymentMethod)}\n\n` +
      `You can complete the rest on the dealer portal. Send *menu* for more.`,
  );
}

/** Read the active lead context off the (freshly loaded) session. */
async function getLeadCtx(
  session: SessionRow,
): Promise<NonNullable<Ctx["lead"]>> {
  const fresh = await loadSession(session.id);
  return ((fresh.context as Ctx)?.lead ?? {}) as NonNullable<Ctx["lead"]>;
}

/** Send a document (PDF) to the dealer by public URL and log it. */
async function replyDocument(
  session: SessionRow,
  link: string,
  filename: string,
  caption?: string,
): Promise<void> {
  const res = await getAdapter().sendDocument(
    session.wa_phone,
    link,
    filename,
    caption,
  );
  await logDocumentSend(session, res, caption);
}

/** Send a document (PDF) to the dealer by uploading its BYTES — used for the
 *  consent PDFs, whose storage URL (S3 files proxy / localhost) isn't reachable
 *  by Meta. The provider hosts the bytes, so this works in dev and prod. */
async function replyDocumentBytes(
  session: SessionRow,
  bytes: Buffer,
  mimeType: string,
  filename: string,
  caption?: string,
): Promise<void> {
  const res = await getAdapter().sendDocumentBytes(
    session.wa_phone,
    bytes,
    mimeType,
    filename,
    caption,
  );
  await logDocumentSend(session, res, caption);
}

async function logDocumentSend(
  session: SessionRow,
  res: { ok: boolean; providerMessageId: string | null; raw?: unknown },
  caption?: string,
): Promise<void> {
  await db.insert(whatsappMessages).values({
    session_id: session.id,
    provider_message_id: res.providerMessageId,
    direction: "outbound",
    message_type: "document",
    text_body: caption ?? null,
    delivery_status: res.ok ? "sent" : "failed",
    raw_payload: (res.raw ?? null) as any,
  });
  await setSession(session.id, { last_outbound_at: new Date() });
}

// ── Console: customer KYC consent (Hot + finance leads) ──────────────────────

const CONSENT_CHANNEL_BUTTONS: ReplyButton[] = [
  { id: "consent_call", title: "📞 Call" },
  { id: "consent_manual", title: "✍ Manual" },
];

const CONSENT_SEND_BUTTON: ReplyButton = {
  id: "consent_send",
  title: "📤 Submit to iTarang",
};
/** Open the Step-4 extra-documents bucket from the submit prompt. */
const EXTRA_DOCS_BUTTON: ReplyButton = {
  id: "xd_open",
  title: "📎 Extra docs",
};

// At the digital-consent wait step the dealer can pull the latest signing status
// (so they aren't stranded if the async Digio webhook is delayed). Manual path only.
const CONSENT_CHECK_BUTTON: ReplyButton = {
  id: "consent_check",
  title: "✅ Check if signed",
};

// At the OTP-wait step the dealer can send the customer a fresh OTP.
const CONSENT_RESEND_OTP_BUTTON: ReplyButton = {
  id: "consent_resend_otp",
  title: "🔁 Resend OTP",
};

/** Render the unsigned consent PDF preview and ask the dealer for a delivery
 *  channel. Called right after a Hot + finance lead is saved. */
async function startConsent(
  session: SessionRow,
  dealer: ActiveDealer,
  leadId: string,
): Promise<void> {
  const preview = await renderConsentPreviewPdf({
    leadId,
    dealerName: dealer.dealerName,
  });
  if (preview.ok) {
    await replyDocumentBytes(
      session,
      preview.pdfBuffer,
      "application/pdf",
      `consent-${leadId}.pdf`,
      "📄 Customer KYC consent form",
    );
  }
  await setSession(session.id, { current_state: "DC_LEAD_CONSENT_CHANNEL" });
  await reply(
    session,
    "How would you like to get the customer's *signature* on the consent?",
    CONSENT_CHANNEL_BUTTONS,
  );
}

async function onConsentChannel(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  const id = (event.text ?? "").trim().toLowerCase();
  const lead = await getLeadCtx(session);
  if (!lead.leadId) {
    await reply(session, "Something went wrong. Send *menu* to start again.");
    return;
  }

  const isManual = id === "consent_manual" || /manual/.test(id);
  const isCall = id === "consent_call" || /\bcall\b/.test(id);

  if (isManual) {
    const gen = await generateManualConsentPdf({
      leadId: lead.leadId,
      dealerName: dealer.dealerName,
    });
    if (!gen.ok) {
      await reply(
        session,
        `Couldn't generate the consent PDF: ${gen.error}. Please try again.`,
        CONSENT_CHANNEL_BUTTONS,
      );
      return;
    }
    await replyDocumentBytes(
      session,
      gen.pdfBuffer,
      "application/pdf",
      gen.fileName,
      "✍ Print this, get the customer's signature, then *upload the signed PDF here*.",
    );
    await setSession(session.id, { current_state: "DC_LEAD_CONSENT_WAIT" });
    return;
  }

  if (isCall) {
    const channel = "call";
    const res = await sendConsentOtp({
      leadId: lead.leadId,
      channel,
      dealerName: dealer.dealerName,
    });
    if (!res.ok) {
      await reply(
        session,
        `Couldn't send the consent OTP: ${res.error}. Please try again, or pick *Manual*.`,
        CONSENT_CHANNEL_BUTTONS,
      );
      return;
    }
    await mergeContext(session, (ctx) => {
      ctx.lead = { ...(ctx.lead ?? {}), consentOtpAttempts: 0, consentOtpChannel: channel };
    });
    await setSession(session.id, { current_state: "DC_LEAD_CONSENT_OTP_WAIT" });
    await reply(
      session,
      `🔐 A 6-digit OTP was sent to the customer via *Call* on ${res.otpSentTo}.\n\n` +
        `Ask the customer to read it out, then *type the 6 digits here* to record their consent.` +
        (res.devOtp ? `\n\n_(dev/test: OTP is ${res.devOtp})_` : ""),
      [CONSENT_RESEND_OTP_BUTTON],
    );
    return;
  }

  await reply(
    session,
    "Please tap *Call* or *Manual*.",
    CONSENT_CHANNEL_BUTTONS,
  );
}

async function onConsentWait(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  // A manually-signed consent comes back as a document/image upload.
  if (event.type === "document" || event.type === "image") {
    const lead = await getLeadCtx(session);
    if (!lead.leadId) {
      await reply(session, "Send *menu* to start again.");
      return;
    }
    if (!event.mediaProviderId) {
      await reply(session, "I couldn't read that file. Please resend the signed consent PDF.");
      return;
    }
    let media;
    try {
      media = await getAdapter().downloadMedia(event.mediaProviderId);
    } catch {
      await reply(session, "I couldn't download that file. Please resend it.");
      return;
    }
    const res = await storeSignedConsent({
      leadId: lead.leadId,
      buffer: media.buffer,
    });
    if (!res.ok) {
      await reply(session, `Couldn't save the signed consent: ${res.error}. Please resend.`);
      return;
    }
    await presentSignedConsent(
      session,
      res.fileUrl,
      "✅ *Signed consent received.*",
      media.buffer,
    );
    return;
  }

  // Dealer is pulling the digital-signing status (button tap or typed "check").
  const t = (event.text ?? "").trim().toLowerCase();
  const wantsCheck =
    t === "consent_check" || /\b(check|status|signed|done|verify)\b/.test(t);
  if (wantsCheck) {
    const lead = await getLeadCtx(session);
    if (!lead.leadId) {
      await reply(session, "Send *menu* to start again.");
      return;
    }
    await reply(session, "⏳ Checking the signing status…");
    const signed = await getSignedConsentForLead(lead.leadId);
    if (signed.signed) {
      await presentSignedConsent(
        session,
        signed.url,
        "✅ *Customer signed the consent successfully!*",
        signed.pdfBuffer ?? undefined,
      );
    } else {
      await reply(
        session,
        "The customer hasn't signed yet. I'll notify you as soon as they do — or tap *Check if signed* again in a moment.",
        [CONSENT_CHECK_BUTTON],
      );
    }
    return;
  }

  await reply(
    session,
    "⏳ Waiting for the customer to sign the consent — tap *Check if signed* once they have, and I'll confirm here.\n\n" +
      "Collecting the signature *manually*? Upload the signed PDF here. Send *menu* to exit.",
    [CONSENT_CHECK_BUTTON],
  );
}

/** Show the signed consent + the "Send to iTarang" button, moving to review.
 *  Prefers sending the bytes (when we have them, e.g. the dealer's upload) so
 *  the file reaches Meta even when its storage URL isn't publicly reachable. */
async function presentSignedConsent(
  session: SessionRow,
  url: string | null,
  headline: string,
  bytes?: Buffer,
): Promise<void> {
  if (bytes) {
    await replyDocumentBytes(
      session,
      bytes,
      "application/pdf",
      "signed-consent.pdf",
      headline,
    );
  } else if (url) {
    await replyDocument(session, url, "signed-consent.pdf", headline);
  } else {
    await reply(session, headline);
  }

  // For Hot + iTarang-finance / Hot + other-finance leads we collect three
  // additional finance details (resident status + existing health / life
  // insurance) AFTER the signed consent, before the dealer submits to iTarang.
  // Any other combination (shouldn't normally reach here, since consent is only
  // taken for those) skips straight to the submit step.
  const lead = await getLeadCtx(session);
  if (
    lead.interest &&
    lead.paymentMethod &&
    requiresConsent(lead.interest, lead.paymentMethod)
  ) {
    await startFinanceQuestions(session);
    return;
  }
  await promptSubmitToITarang(session);
}

/** Capture the 6-digit consent OTP the customer reads out, typed back into the
 *  chat (or a Resend tap). Verifies it (auto-completing the consent) and
 *  advances the flow; relays the server's wrong/expired/locked message. E-180. */
async function onConsentOtpWait(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  const lead = await getLeadCtx(session);
  if (!lead.leadId) {
    await reply(session, "Send *menu* to start again.");
    return;
  }

  const raw = (event.text ?? "").trim();
  const channel = lead.consentOtpChannel ?? "call";

  // Resend button / typed "resend".
  if (
    (event.type === "interactive" && raw.toLowerCase() === "consent_resend_otp") ||
    /^resend\b/i.test(raw)
  ) {
    const res = await sendConsentOtp({
      leadId: lead.leadId,
      channel,
      dealerName: dealer.dealerName,
    });
    if (!res.ok) {
      await reply(session, `Couldn't resend the OTP: ${res.error}.`, [CONSENT_RESEND_OTP_BUTTON]);
      return;
    }
    await mergeContext(session, (ctx) => {
      ctx.lead = { ...(ctx.lead ?? {}), consentOtpAttempts: 0 };
    });
    await reply(
      session,
      `🔁 A fresh OTP was sent to the customer on ${res.otpSentTo}. Ask them to read it out and type the 6 digits here.` +
        (res.devOtp ? `\n\n_(dev/test: OTP is ${res.devOtp})_` : ""),
      [CONSENT_RESEND_OTP_BUTTON],
    );
    return;
  }

  const otp = raw.replace(/\D/g, "").slice(0, 6);
  if (otp.length !== 6) {
    await reply(
      session,
      "Please type the *6-digit OTP* the customer received, or tap *Resend OTP*.",
      [CONSENT_RESEND_OTP_BUTTON],
    );
    return;
  }

  const res = await verifyConsentOtp({ leadId: lead.leadId, otp });
  if (res.ok) {
    await reply(session, "✅ *Consent recorded.* Thank you!");
    await afterConsentCaptured(session);
    return;
  }

  // Wrong / expired / locked — verifyConsentOtp returns the exact message
  // (attempts remaining / lockout) and tracks attempts server-side.
  await mergeContext(session, (ctx) => {
    ctx.lead = { ...(ctx.lead ?? {}), consentOtpAttempts: (lead.consentOtpAttempts ?? 0) + 1 };
  });
  await reply(session, `❌ ${res.error}`, [CONSENT_RESEND_OTP_BUTTON]);
}

/** After consent is captured (OTP verified), continue the lead flow exactly as
 *  the signed-consent path does: finance questions for finance leads, else the
 *  submit-to-iTarang review step. */
async function afterConsentCaptured(session: SessionRow): Promise<void> {
  const lead = await getLeadCtx(session);
  if (
    lead.interest &&
    lead.paymentMethod &&
    requiresConsent(lead.interest, lead.paymentMethod)
  ) {
    await startFinanceQuestions(session);
    return;
  }
  await promptSubmitToITarang(session);
}

/** Move to the consent-review step and show the "Submit to iTarang" button. */
async function promptSubmitToITarang(session: SessionRow): Promise<void> {
  await setSession(session.id, { current_state: "DC_LEAD_CONSENT_REVIEW" });
  await reply(
    session,
    "Review the signed consent above. When ready, tap *Submit to iTarang* — the documents, extracted details and signed consent all go to the iTarang team for KYC review.\n\n" +
      "Need to attach extra files for the lenders (up to 10)? Tap *Extra docs*.",
    [CONSENT_SEND_BUTTON, EXTRA_DOCS_BUTTON],
  );
}

// ── Console: additional finance details (post-consent, Hot + finance leads) ──
// Three quick taps mirroring the web "Additional Finance Details" card: resident
// status (Owned/Rented) + existing health / life insurance (Yes/No). Stored on
// the leads row (resident_status / has_health_insurance / has_life_insurance —
// E-130) so the WhatsApp lead matches a web-created finance lead before it
// reaches admin KYC review. Asked one at a time so each is a single tap.

type FinanceQuestion = {
  /** Target leads column for this answer. */
  key: "resident_status" | "has_health_insurance" | "has_life_insurance";
  body: string;
  buttons: ReplyButton[];
  /** Map a button id / typed answer → the value written to the leads column. */
  parse: (event: InboundEvent) => string | boolean | null;
};

const ADDITIONAL_FINANCE_QUESTIONS: FinanceQuestion[] = [
  {
    key: "resident_status",
    body: "📋 *Additional Finance Details* (1/3)\n\n*Resident Status*\nDoes the customer *own* or *rent* their current residence?",
    buttons: [
      { id: "resident_owned", title: "🏠 Owned" },
      { id: "resident_rented", title: "🔑 Rented" },
    ],
    parse: (event) => {
      const t = (event.text ?? "").trim().toLowerCase();
      if (t === "resident_owned" || /\bown(ed)?\b/.test(t)) return "owned";
      if (t === "resident_rented" || /\brent(ed)?\b/.test(t)) return "rented";
      return null;
    },
  },
  {
    key: "has_health_insurance",
    body: "🩺 *Existing Health Insurance* (2/3)\n\nDoes the customer currently hold their own *health insurance* policy?",
    buttons: [
      { id: "health_yes", title: "Yes" },
      { id: "health_no", title: "No" },
    ],
    parse: (event) => parseYesNo(event, "health"),
  },
  {
    key: "has_life_insurance",
    body: "💚 *Existing Life Insurance* (3/3)\n\nDoes the customer currently hold their own *life insurance* policy?",
    buttons: [
      { id: "life_yes", title: "Yes" },
      { id: "life_no", title: "No" },
    ],
    parse: (event) => parseYesNo(event, "life"),
  },
];

/** Resolve a Yes/No answer from a button tap (prefixed id) or typed text. */
function parseYesNo(event: InboundEvent, prefix: string): boolean | null {
  const t = (event.text ?? "").trim().toLowerCase();
  if (event.type === "interactive") {
    if (t === `${prefix}_yes`) return true;
    if (t === `${prefix}_no`) return false;
  }
  if (/^(yes|y|haan|ha|yep|sure|hai|ji|jee|हाँ|हां|जी|ok|okay|theek hai|ठीक है)$/i.test(t)) return true;
  if (/^(no|n|nahi|nope|nahin|नहीं|नही|na)$/i.test(t)) return false;
  return null;
}

/** Begin the 3-question additional-finance step at question 1. */
async function startFinanceQuestions(session: SessionRow): Promise<void> {
  await mergeContext(session, (ctx) => {
    ctx.lead = { ...(ctx.lead ?? {}), financeQIndex: 0 };
  });
  await setSession(session.id, { current_state: "DC_LEAD_FINANCE_Q" });
  await reply(
    session,
    ADDITIONAL_FINANCE_QUESTIONS[0].body,
    ADDITIONAL_FINANCE_QUESTIONS[0].buttons,
  );
}

async function onLeadFinanceQuestion(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const lead = await getLeadCtx(session);
  const idx = lead.financeQIndex ?? 0;
  const question = ADDITIONAL_FINANCE_QUESTIONS[idx];

  // Context lost (e.g. restart mid-flow) — fall back to the submit step.
  if (!question || !lead.leadId) {
    await promptSubmitToITarang(session);
    return;
  }

  const value = question.parse(event);
  if (value === null) {
    await reply(
      session,
      `Please tap one of the options below.\n\n${question.body}`,
      question.buttons,
    );
    return;
  }

  // Persist this answer onto the lead immediately so partial progress survives.
  await db
    .update(leads)
    .set({ [question.key]: value, updated_at: new Date() } as any)
    .where(eq(leads.id, lead.leadId));

  const nextIdx = idx + 1;
  const next = ADDITIONAL_FINANCE_QUESTIONS[nextIdx];
  if (next) {
    await mergeContext(session, (ctx) => {
      ctx.lead = { ...(ctx.lead ?? {}), financeQIndex: nextIdx };
    });
    await reply(session, next.body, next.buttons);
    return;
  }

  // All three answered → on to the Submit-to-iTarang review step.
  await reply(session, "Thanks — that's all the finance details. ✅");
  await promptSubmitToITarang(await loadSession(session.id));
}

async function onConsentReview(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const id = (event.text ?? "").trim().toLowerCase();
  if (id === "consent_send" || /\b(send|submit)\b/.test(id)) {
    return await finalizeLead(session);
  }
  if (id === "xd_open" || /\bextra\b/.test(id)) {
    const lead = await getLeadCtx(session);
    if (lead.leadId) {
      return await openExtraDocs(session, lead.leadId, { next: "submit" });
    }
  }
  await reply(
    session,
    "Tap *Submit to iTarang* to send the documents and signed consent for KYC review, *Extra docs* to attach more files, or send *menu* to exit.",
    [CONSENT_SEND_BUTTON, EXTRA_DOCS_BUTTON],
  );
}

/**
 * Push the signed consent into an active WhatsApp lead conversation. Called by
 * the Digio webhook once the customer e-signs, so the dealer sees "✅ Customer
 * signed" + the signed PDF without polling. No-op if no console session is
 * parked at the consent-wait step for this lead.
 */
export async function pushSignedConsentToWhatsApp(
  leadId: string,
  signedUrl: string | null,
): Promise<void> {
  try {
    const rows = await db
      .select()
      .from(whatsappOnboardingSessions)
      .where(
        and(
          sql`${whatsappOnboardingSessions.context} -> 'lead' ->> 'leadId' = ${leadId}`,
          eq(whatsappOnboardingSessions.current_state, "DC_LEAD_CONSENT_WAIT"),
        ),
      )
      .orderBy(desc(whatsappOnboardingSessions.updated_at))
      .limit(1);
    const session = rows[0];
    if (!session) return;
    // Fetch the signed PDF bytes so it sends reliably (its storage URL may not
    // be publicly reachable by Meta); fall back to the URL the webhook passed.
    let bytes: Buffer | undefined;
    let url = signedUrl;
    try {
      const lookup = await getSignedConsentForLead(leadId);
      if (lookup.signed) {
        bytes = lookup.pdfBuffer ?? undefined;
        url = url ?? lookup.url;
      }
    } catch {
      /* best-effort — fall back to the URL */
    }
    await presentSignedConsent(
      session,
      url,
      "✅ *Customer signed the consent successfully!*",
      bytes,
    );
  } catch (err) {
    console.error("[WhatsApp/console] pushSignedConsent failed:", err);
  }
}

/**
 * Push a consent FAILURE (Aadhaar mismatch / eSign failed / expired) into an
 * active WhatsApp lead conversation. Called by the Digio webhook so the dealer
 * isn't left waiting silently at the consent-wait step — it explains what went
 * wrong and drops them back to the channel chooser to re-send. No-op if no
 * console session is parked at the consent-wait step for this lead.
 */
export async function pushConsentFailureToWhatsApp(
  leadId: string,
  reason: string,
): Promise<void> {
  try {
    const rows = await db
      .select()
      .from(whatsappOnboardingSessions)
      .where(
        and(
          sql`${whatsappOnboardingSessions.context} -> 'lead' ->> 'leadId' = ${leadId}`,
          eq(whatsappOnboardingSessions.current_state, "DC_LEAD_CONSENT_WAIT"),
        ),
      )
      .orderBy(desc(whatsappOnboardingSessions.updated_at))
      .limit(1);
    const session = rows[0];
    if (!session) return;

    await reply(
      session,
      `⚠️ *Consent could not be completed.*\n\n${reason}\n\n` +
        `Please re-send the consent so the customer can sign again with *their own Aadhaar*, ` +
        `or choose *Manual* to collect a printed signature.`,
    );
    await setSession(session.id, { current_state: "DC_LEAD_CONSENT_CHANNEL" });
    await reply(
      session,
      "How would you like to get the customer's *signature* on the consent?",
      CONSENT_CHANNEL_BUTTONS,
    );
  } catch (err) {
    console.error("[WhatsApp/console] pushConsentFailure failed:", err);
  }
}

// ── Console: customer KYC documents + extraction ─────────────────────────────

const REQUIRED_CUSTOMER_DOCS = [
  "aadhaar_front",
  "aadhaar_back",
  "pan_card",
  "rc_copy",
  "customer_photo",
] as const;

// Documents the customer MAY send but that never block completion. The bank
// cheque / passbook is optional — a lead can be submitted without it, but if
// the dealer does upload one we still classify, extract, and store it.
const OPTIONAL_CUSTOMER_DOCS = ["cancelled_cheque"] as const;

// Every customer doc type we accept on upload (required + optional). Used by the
// classifiers so an optional cheque/passbook is still recognized and stored,
// even though it isn't part of the required set.
const ACCEPTED_CUSTOMER_DOCS = [
  ...REQUIRED_CUSTOMER_DOCS,
  ...OPTIONAL_CUSTOMER_DOCS,
] as const;

function customerDocLabel(type: string): string {
  switch (type) {
    case "aadhaar_front":
      return "Aadhaar (front)";
    case "aadhaar_back":
      return "Aadhaar (back)";
    case "pan_card":
      return "PAN card";
    case "customer_photo":
      return "Passport-size photo";
    case "address_proof":
      return "Address proof";
    case "rc_copy":
      return "RC copy";
    case "cancelled_cheque":
      return "Bank cheque / passbook";
    default:
      return type;
  }
}

function customerDocsChecklistMessage(): string {
  return [
    "📎 *Customer documents needed*",
    "",
    "Please send these (one by one, or all together — photos, PDFs, or a ZIP):",
    "",
    "*Required:*",
    "1️⃣ Aadhaar — *front*",
    "2️⃣ Aadhaar — *back*",
    "3️⃣ PAN card",
    "4️⃣ *RC copy* (vehicle Registration Certificate)",
    "5️⃣ Passport-size *photo*",
    "",
    "*Optional* (send if you have them):",
    "▫️ *Bank cheque* (cancelled cheque) or *passbook photo*",
    "",
    "Type *done* when you've sent everything.",
  ].join("\n");
}

async function startDocs(session: SessionRow): Promise<void> {
  await mergeContext(session, (ctx) => {
    if (ctx.lead) ctx.lead.docs = ctx.lead.docs ?? {};
  });
  // Show the required-document list, then ask HOW they want to send them —
  // one at a time or all together in a folder (ZIP).
  await setSession(session.id, { current_state: "DC_LEAD_DOCS_MODE" });
  await reply(session, customerDocsChecklistMessage());
  await reply(
    session,
    "How would you like to send them? Put *all documents in one folder (ZIP)* and upload together, or send them *one at a time*. 👇",
    UPLOAD_MODE_BUTTONS,
  );
}

// Dealer picked how to send the customer documents (ZIP vs one-by-one). Either
// way the ingestion (onLeadDocs) accepts both; this just sets expectations. If
// they skip the choice and send a file straight away, treat it as an upload.
async function onLeadDocsMode(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  if (event.mediaProviderId) {
    await setSession(session.id, { current_state: "DC_LEAD_DOCS" });
    return await onLeadDocs(await loadSession(session.id), event, dealer);
  }

  const id = event.type === "interactive" ? (event.text ?? "") : "";
  const text = (event.text ?? "").toLowerCase();
  const wantsZip =
    id === "upload_zip" || /\b(zip|folder|all|together|batch)\b/.test(text);
  const wantsOne =
    id === "upload_one" || /\b(one|single|individual|by\s*one|ek)\b/.test(text);

  if (wantsZip) {
    await setSession(session.id, { current_state: "DC_LEAD_DOCS" });
    await reply(
      session,
      "📦 Great — attach a *single .zip file* containing all the documents from the list above. I'll read them all. Type *done* when finished.",
    );
    return;
  }
  if (wantsOne) {
    await setSession(session.id, { current_state: "DC_LEAD_DOCS" });
    await reply(
      session,
      "📄 No problem — send each document one at a time as a *photo or PDF*. Type *done* when finished.",
    );
    return;
  }

  await reply(
    session,
    "Please tap *Upload all (ZIP)* or *Send one by one*.",
    UPLOAD_MODE_BUTTONS,
  );
}

/** Normalize a classifier guess to one of the 5 customer doc types, or null.
 *  Business photo / company-PAN guesses are folded into their customer cousins
 *  because the dealer is explicitly in the customer-document step. */
function normalizeCustomerDocType(raw: string): string | null {
  switch (raw) {
    case "owner_photo":
    case "partner_photo":
      return "customer_photo";
    case "company_pan":
      return "pan_card";
    default:
      return (ACCEPTED_CUSTOMER_DOCS as readonly string[]).includes(raw)
        ? raw
        : null;
  }
}

function mimeFromName(name: string): string | null {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "pdf") return "application/pdf";
  return null;
}

async function onLeadDocs(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  if (event.type === "text") {
    const t = (event.text ?? "").trim();
    if (/^(done|finish|finished|complete|completed|that'?s all|bas|ho gaya|hogaya|बस|हो गया|पूरा|poora|pura)$/i.test(t)) {
      return await proceedToConsent(session, dealer);
    }
    await reply(
      session,
      "Send the customer's documents as photos or PDFs. Type *done* when finished.",
    );
    return;
  }

  if (event.type === "document" || event.type === "image") {
    if (!event.mediaProviderId) {
      await reply(session, "I couldn't read that file. Please resend it.");
      return;
    }
    let media;
    try {
      media = await getAdapter().downloadMedia(event.mediaProviderId);
    } catch {
      await reply(session, "I couldn't download that file. Please resend it.");
      return;
    }

    const isZip =
      /zip/i.test(media.mimeType) ||
      /\.zip$/i.test(media.fileName ?? event.fileName ?? "");
    if (isZip) {
      await ingestCustomerZip(session, media.buffer);
    } else {
      await ingestCustomerDoc(
        session,
        media.buffer,
        media.mimeType,
        media.fileName ?? event.fileName,
      );
    }

    const lead = await getLeadCtx(session);
    const have = Object.keys(lead.docs ?? {});
    if (REQUIRED_CUSTOMER_DOCS.every((d) => have.includes(d))) {
      return await proceedToConsent(session, dealer);
    }
    return;
  }

  await reply(session, "Please send the documents as photos or PDFs, or type *done*.");
}

/** Save a customer document, link it to the lead, and fill its extracted
 *  fields. No messaging — callers report progress / summaries themselves. */
async function persistCustomerDoc(
  leadId: string,
  docType: string,
  buffer: Buffer,
  mimeType: string,
  fileName: string | undefined,
  fields: Record<string, unknown>,
): Promise<void> {
  const saved = await saveMedia({
    buffer,
    mimeType,
    keyPrefix: `leads/${leadId}/whatsapp`,
    docType,
    fileName,
  });
  await db.insert(leadDocuments).values({
    id: crypto.randomUUID(),
    lead_id: leadId,
    type: docType,
    document_type: docType,
    url: saved.fileUrl,
    file_url: saved.fileUrl,
  });

  // Also surface the file to the admin KYC review, which reads kyc_documents
  // (NOT the `documents` table above). doc_type is kept identical to the web KYC
  // types where they match (aadhaar_front/aadhaar_back/pan_card/rc_copy/
  // address_proof) so the admin verification cards + OCR lookups resolve; the
  // two WhatsApp-only types are mapped to their nearest web slots. Replace any
  // earlier row of the same type so a re-upload doesn't leave duplicates.
  const kycDocType = toKycDocType(docType);
  await db
    .delete(kycDocuments)
    .where(
      and(
        eq(kycDocuments.lead_id, leadId),
        eq(kycDocuments.doc_type, kycDocType),
        eq(kycDocuments.doc_for, "customer"),
      ),
    );
  await db.insert(kycDocuments).values({
    id: crypto.randomUUID(),
    lead_id: leadId,
    doc_type: kycDocType,
    doc_for: "customer",
    file_url: saved.fileUrl,
    file_name: fileName ?? null,
    file_type: mimeType,
    verification_status: "pending",
    doc_status: "uploaded",
    ocr_data: fields as any,
  });

  await fillCustomerLeadFromDoc(leadId, docType, fields);
}

/** Map a WhatsApp customer doc type to the canonical kyc_documents.doc_type the
 *  admin KYC review keys on. Matching types pass through unchanged. */
function toKycDocType(waType: string): string {
  switch (waType) {
    case "customer_photo":
      return "passport_photo";
    case "cancelled_cheque":
      return "cheque_1";
    default:
      return waType;
  }
}

const MAX_CUSTOMER_ZIP_ENTRIES = 25;

/**
 * Scan a ZIP of customer documents in one shot: classify every file, verify the
 * ID documents all belong to ONE person, save the consistent ones, and report a
 * single consolidated result — a mismatch warning if two people's documents are
 * mixed, otherwise an "all documents are correct" success.
 */
async function ingestCustomerZip(
  session: SessionRow,
  buffer: Buffer,
): Promise<void> {
  const lead = await getLeadCtx(session);
  if (!lead.leadId) {
    await reply(session, "Send *menu* to start again.");
    return;
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    await reply(
      session,
      "I couldn't open that ZIP. Please resend it, or send the files one by one.",
    );
    return;
  }

  // Pull out the readable image/PDF entries (skip dirs, macOS forks, others).
  const files: { name: string; buffer: Buffer; mime: string }[] = [];
  for (const f of Object.values(zip.files)) {
    if (f.dir) continue;
    const base = f.name.split("/").pop() ?? f.name;
    if (f.name.startsWith("__MACOSX/") || base.startsWith(".")) continue;
    const mime = mimeFromName(base);
    if (!mime) continue;
    files.push({ name: base, buffer: await f.async("nodebuffer"), mime });
    if (files.length >= MAX_CUSTOMER_ZIP_ENTRIES) break;
  }
  if (files.length === 0) {
    await reply(
      session,
      "That ZIP didn't contain any readable images or PDFs. Please send JPG/PNG/PDF files, or send each document one by one.",
    );
    return;
  }

  await reply(
    session,
    "📦 Got your ZIP — scanning all the documents now, one moment…",
  );

  // Classify every file in parallel (the slow part).
  const classifications = await Promise.all(
    files.map((f) => classifyDocument(f.buffer, f.mime)),
  );

  // Recognise each file → a customer doc type (+ its name for ID docs).
  type Recognized = {
    file: { name: string; buffer: Buffer; mime: string };
    docType: string;
    name: string;
    fields: Record<string, unknown>;
  };
  const recognized: Recognized[] = [];
  const unreadable: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const c = classifications[i];
    const docType = c.ok ? normalizeCustomerDocType(c.documentType) : null;
    if (!docType) {
      unreadable.push(files[i].name);
      continue;
    }
    recognized.push({
      file: files[i],
      docType,
      name: NAME_BEARING_DOCS.has(docType) ? str(c.fields.name) : "",
      fields: c.fields,
    });
  }

  // Establish the customer's name: a name already locked in, else the first
  // name-bearing ID document in this batch.
  let canonical = str(lead.customerName);
  if (!canonical) canonical = recognized.find((r) => r.name)?.name ?? "";

  // Cross-LEAD duplicate check: if any ID document in this batch belongs to a
  // customer already in process with iTarang, refuse the whole batch before
  // saving anything — the same customer can't be re-created on a new lead.
  for (const r of recognized) {
    const dup = await duplicateInProcessLead(lead.leadId, r.docType, r.fields);
    if (dup) {
      await setSession(session.id, { current_state: "DC_MENU" });
      await reply(session, duplicateLeadMessage(dup.referenceId));
      return;
    }
  }

  // Save the documents consistent with the customer; collect the mismatched ID
  // documents (a different person) WITHOUT saving them.
  const acceptedLabels = new Set<string>();
  const savedTypes: string[] = [];
  const mismatched: { label: string; name: string }[] = [];
  for (const r of recognized) {
    if (r.name && canonical && !namesMatch(canonical, r.name)) {
      mismatched.push({ label: customerDocLabel(r.docType), name: r.name });
      continue;
    }
    await persistCustomerDoc(
      lead.leadId,
      r.docType,
      r.file.buffer,
      r.file.mime,
      r.file.name,
      r.fields,
    );
    savedTypes.push(r.docType);
    acceptedLabels.add(customerDocLabel(r.docType));
  }

  // Persist the saved docs + the locked-in customer name.
  await mergeContext(session, (ctx) => {
    if (!ctx.lead) ctx.lead = {};
    const docs = { ...(ctx.lead.docs ?? {}) };
    for (const t of savedTypes) docs[t] = true;
    ctx.lead.docs = docs;
    if (canonical && !str(ctx.lead.customerName)) ctx.lead.customerName = canonical;
  });

  // Build the consolidated result message.
  const have = Object.keys((await getLeadCtx(session)).docs ?? {});
  const missing = REQUIRED_CUSTOMER_DOCS.filter((d) => !have.includes(d)).map(
    customerDocLabel,
  );

  const parts: string[] = [];
  if (acceptedLabels.size) {
    parts.push(
      "✅ Received:\n" + [...acceptedLabels].map((l) => `• ${l}`).join("\n"),
    );
  }
  if (mismatched.length) {
    parts.push(
      `⚠️ *Document mismatch* — these don't belong to the same customer:\n` +
        `• *Customer:* ${canonical || "—"}\n` +
        mismatched.map((m) => `• *${m.label}:* ${m.name}`).join("\n") +
        `\n\nPlease check and resend the correct *${mismatched
          .map((m) => m.label)
          .join(", ")}* for *${canonical || "the customer"}*.`,
    );
  }
  if (unreadable.length) {
    parts.push(
      "🚫 Couldn't read / identify:\n" +
        unreadable.map((n) => `• ${n}`).join("\n"),
    );
  }
  if (!mismatched.length && missing.length) {
    parts.push("Still needed:\n" + missing.map((l) => `• ${l}`).join("\n"));
  }
  if (!mismatched.length && missing.length === 0) {
    parts.push(
      `🎉 *All documents are correct* — every document belongs to *${canonical || "the customer"}*.`,
    );
  }
  await reply(session, parts.join("\n\n"));
}

async function ingestCustomerDoc(
  session: SessionRow,
  buffer: Buffer,
  mimeType: string,
  fileName?: string,
): Promise<void> {
  const lead = await getLeadCtx(session);
  if (!lead.leadId) {
    await reply(session, "Send *menu* to start again.");
    return;
  }

  const cls = await classifyDocument(buffer, mimeType);
  const docType = cls.ok ? normalizeCustomerDocType(cls.documentType) : null;
  if (!docType) {
    await reply(
      session,
      "I couldn't tell which document that is. Please send a clear photo of the *Aadhaar*, *PAN*, *photo* or *address proof*.",
    );
    return;
  }

  // Cross-document identity check: all the ID documents must belong to ONE
  // person. The first name-bearing ID (Aadhaar front / PAN) establishes the
  // customer's name; a later ID whose name doesn't match is rejected — so two
  // different people's documents can't be mixed onto one lead.
  const docName = str(cls.fields.name);
  if (NAME_BEARING_DOCS.has(docType) && docName) {
    const established = str(lead.customerName);
    if (established && !namesMatch(established, docName)) {
      await reply(
        session,
        `⚠️ This document doesn't match the customer.\n\n` +
          `*Customer name:* ${established}\n` +
          `*${customerDocLabel(docType)} name:* ${docName}\n\n` +
          `Please check and send the *${customerDocLabel(docType)}* that belongs to *${established}*.`,
      );
      return;
    }
  }

  // Cross-LEAD duplicate check: if this PAN / Aadhaar already belongs to another
  // lead in process with iTarang, refuse — the same customer can't be re-created.
  const dup = await duplicateInProcessLead(lead.leadId, docType, cls.fields);
  if (dup) {
    await setSession(session.id, { current_state: "DC_MENU" });
    await reply(session, duplicateLeadMessage(dup.referenceId));
    return;
  }

  await persistCustomerDoc(lead.leadId, docType, buffer, mimeType, fileName, cls.fields);

  await mergeContext(session, (ctx) => {
    if (!ctx.lead) ctx.lead = {};
    ctx.lead.docs = { ...(ctx.lead.docs ?? {}), [docType]: true };
    // Lock in the customer's name from the first name-bearing ID document.
    if (NAME_BEARING_DOCS.has(docType) && docName && !str(ctx.lead.customerName)) {
      ctx.lead.customerName = docName;
    }
  });

  // Progress counts REQUIRED docs only — an optional cheque/passbook shouldn't
  // push the tally past the denominator (e.g. "6/5").
  const haveDocs = Object.keys((await getLeadCtx(session)).docs ?? {});
  const haveCount = REQUIRED_CUSTOMER_DOCS.filter((d) => haveDocs.includes(d)).length;
  await reply(
    session,
    `Got *${customerDocLabel(docType)}* ✅ (${haveCount}/${REQUIRED_CUSTOMER_DOCS.length})`,
  );
}

// ID documents that print the customer's name — used for the cross-document
// identity match. Aadhaar back (address only) and the photo carry no name.
const NAME_BEARING_DOCS = new Set<string>(["aadhaar_front", "pan_card"]);

/** If the PAN / Aadhaar read off this document already belongs to a DIFFERENT
 *  lead that's in process with iTarang, return that lead; else null. Lets the
 *  ingest paths block a duplicate customer before the document is saved. */
async function duplicateInProcessLead(
  leadId: string,
  docType: string,
  fields: Record<string, unknown>,
) {
  let pan: string | undefined;
  let aadhaar: string | undefined;
  if (docType === "pan_card") {
    const p = str(fields.pan).toUpperCase().replace(/\s/g, "");
    if (p) pan = p;
  } else if (docType === "aadhaar_front") {
    const a = digitsOnly(fields.aadhaar_number);
    if (a.length === 12) aadhaar = a;
  }
  if (!pan && !aadhaar) return null;
  return findInProcessLeadByIdentity({ pan, aadhaar, excludeLeadId: leadId });
}

function duplicateLeadMessage(ref: string | null): string {
  return (
    "⚠️ This customer already has a lead in process with iTarang" +
    (ref ? ` (*${ref}*)` : "") +
    ".\n\nThese documents are already linked to that lead, so you can't create a " +
    "new lead for this customer — iTarang already has this lead in process.\n\n" +
    "Send *menu* to go back."
  );
}

// Honorifics / titles stripped before comparing names so "Mr. Yogendra" matches
// "Yogendra".
const NAME_HONORIFICS = new Set([
  "mr", "mrs", "ms", "miss", "shri", "sri", "smt", "kumari", "km", "dr", "late",
]);

/** Normalize a printed name to lowercase alphabetic tokens (titles removed). */
function nameTokens(raw: string): string[] {
  return str(raw)
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !NAME_HONORIFICS.has(t));
}

/** True if two name tokens are the "same" — equal, or an initial of the other. */
function tokenMatches(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === 1 && b.startsWith(a)) return true;
  if (b.length === 1 && a.startsWith(b)) return true;
  return false;
}

/**
 * Fuzzy person-name match across ID documents. Tolerant of a missing middle
 * name, initials (Y → Yogendra) and title/spacing/case differences, but rejects
 * a clearly different person (no shared tokens). Empty/unreadable names are
 * treated as a match so a missing extraction never blocks the dealer.
 */
function namesMatch(nameA: string, nameB: string): boolean {
  const a = nameTokens(nameA);
  const b = nameTokens(nameB);
  if (!a.length || !b.length) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const used = new Array(long.length).fill(false);
  let matched = 0;
  for (const t of short) {
    const idx = long.findIndex((u, i) => !used[i] && tokenMatches(t, u));
    if (idx >= 0) {
      used[idx] = true;
      matched++;
    }
  }
  // Require at least half the shorter name's tokens to line up (always ≥ 1).
  return matched >= Math.ceil(short.length / 2);
}

function digitsOnly(v: unknown): string {
  return str(v).replace(/\D/g, "");
}

/**
 * Resolve free-text state/city (from OCR) to the canonical `country-state-city`
 * names the dealer Step-1 dropdowns use (the wizard's State/City <select>s are
 * built from this same package — value must match a name exactly to pre-select).
 * Returns only confident matches; an unmatched value is left undefined so the
 * dealer picks it manually rather than us storing a value the dropdown can't show.
 */
function resolveStateCity(
  rawState: string,
  rawCity: string,
): { state?: string; city?: string } {
  const out: { state?: string; city?: string } = {};
  const s = rawState.trim().toLowerCase();
  if (!s) return out;
  const stateMatch = State.getStatesOfCountry("IN").find(
    (st) => st.name.toLowerCase() === s,
  );
  if (!stateMatch) return out;
  out.state = stateMatch.name;

  const c = rawCity.trim().toLowerCase();
  if (!c) return out;
  const cities = City.getCitiesOfState("IN", stateMatch.isoCode);
  // Exact (case-insensitive) first; else tolerate the "Allahabad" ⇄
  // "Allahabad City" prefix difference between OCR text and the package name.
  const cityMatch =
    cities.find((ct) => ct.name.toLowerCase() === c) ||
    cities.find((ct) => {
      const n = ct.name.toLowerCase();
      return c.startsWith(n) || n.startsWith(c);
    });
  if (cityMatch) out.city = cityMatch.name;
  return out;
}

function parseDobValue(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  // DD/MM/YYYY or DD-MM-YYYY
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Map a customer document's extracted fields into the lead's personal_details. */
async function fillCustomerLeadFromDoc(
  leadId: string,
  docType: string,
  fields: Record<string, unknown>,
): Promise<void> {
  // Customer name — we no longer ask the dealer to type it, so we take it from
  // the PAN / Aadhaar (the authoritative sources) and write it onto the lead,
  // overwriting the "Customer" placeholder set at lead creation.
  const extractedName = str(fields.name);
  if (extractedName && (docType === "aadhaar_front" || docType === "pan_card")) {
    await db
      .update(leads)
      .set({
        full_name: extractedName,
        owner_name: extractedName,
        updated_at: new Date(),
      })
      .where(eq(leads.id, leadId));
  }

  // RC copy → the lead's vehicle registration number.
  if (docType === "rc_copy") {
    const rc = str(fields.registration_number).toUpperCase().replace(/\s+/g, "");
    if (rc) {
      await db
        .update(leads)
        .set({ vehicle_rc: rc, updated_at: new Date() })
        .where(eq(leads.id, leadId));
    }
  }

  const patch: Record<string, unknown> = {};

  if (docType === "aadhaar_front") {
    const a = digitsOnly(fields.aadhaar_number);
    if (a.length === 12) patch.aadhaar_no = a;
    const dob = parseDobValue(fields.dob);
    if (dob) patch.dob = dob;
  } else if (docType === "pan_card") {
    const pan = str(fields.pan).toUpperCase().replace(/\s/g, "");
    if (pan) patch.pan_no = pan;
    const father = str(fields.father_name);
    if (father) patch.father_husband_name = father;
    const dob = parseDobValue(fields.dob);
    if (dob) patch.dob = dob;
  } else if (docType === "aadhaar_back" || docType === "address_proof") {
    const addr =
      str(fields.full_address) ||
      [
        str(fields.address_line1),
        str(fields.city),
        str(fields.state),
        str(fields.pincode),
      ]
        .filter(Boolean)
        .join(", ");
    if (addr) {
      patch.permanent_address = addr;
      patch.local_address = addr;
    }
  }

  if (Object.keys(patch).length === 0) return;
  patch.ocr_processed_at = new Date();
  await db
    .update(personalDetails)
    .set(patch as any)
    .where(eq(personalDetails.lead_id, leadId));

  // Mirror the lead-facing fields onto the leads table too. The web dealer Step-1
  // form (GET /api/dealer/leads/[id]) reads dob / father / addresses straight off
  // `leads`, NOT personal_details — so without this they show blank when a
  // WhatsApp lead is opened for editing. Matches the web PATCH, which writes both.
  const leadPatch: Record<string, unknown> = {};
  if (patch.dob !== undefined) leadPatch.dob = patch.dob;
  if (patch.father_husband_name !== undefined)
    leadPatch.father_or_husband_name = patch.father_husband_name;
  if (patch.permanent_address !== undefined) {
    leadPatch.permanent_address = patch.permanent_address;
    leadPatch.current_address = patch.local_address ?? patch.permanent_address;
  }
  // Address docs also carry state/city — resolve them to the canonical dropdown
  // names so the wizard's State/City selects pre-populate (overwriting the
  // "Unknown" placeholder set at lead creation).
  if (docType === "aadhaar_back" || docType === "address_proof") {
    const loc = resolveStateCity(str(fields.state), str(fields.city));
    if (loc.state) leadPatch.state = loc.state;
    if (loc.city) leadPatch.city = loc.city;
  }
  if (Object.keys(leadPatch).length > 0) {
    leadPatch.updated_at = new Date();
    await db.update(leads).set(leadPatch as any).where(eq(leads.id, leadId));
  }
}

/**
 * Customer documents are in — move on to the KYC consent. Documents come BEFORE
 * consent so the name / PAN / Aadhaar / address extracted from them populate the
 * consent form. Surfaces a heads-up about any still-missing required documents,
 * but doesn't block (the dealer can add them later on the portal).
 */
async function proceedToConsent(
  session: SessionRow,
  dealer: ActiveDealer,
): Promise<void> {
  const lead = await getLeadCtx(session);
  if (!lead.leadId) {
    await showDealerMenu(session, dealer);
    return;
  }
  const have = Object.keys(lead.docs ?? {});
  const missing = REQUIRED_CUSTOMER_DOCS.filter((d) => !have.includes(d)).map(
    customerDocLabel,
  );
  let ack = "Thanks — documents received and details extracted. ✅";
  if (missing.length) {
    ack += `\n\n⚠️ Still missing: ${missing.join(", ")}. You can add these later on the dealer portal.`;
  }
  await reply(session, ack);
  // The optional Step-4 extra-documents bucket sits between the KYC documents
  // and the consent — the same position the web wizard's card occupies
  // relative to the rest of the ladder. Skip is one tap; the continuation
  // registered below carries the turn on to startConsent.
  await askExtraDocs(session, dealer, lead.leadId, "consent");
}

/** Hand-back from the extra-documents step into this ladder. */
registerExtraDocsContinuation(async (session, dealer, next, leadId) => {
  if (next === "consent") {
    await reply(
      session,
      "Now let's get the customer's *KYC consent*. Generating the consent form…",
    );
    await startConsent(session, dealer, leadId);
    return;
  }
  await promptSubmitToITarang(session);
});

async function finalizeLead(session: SessionRow): Promise<void> {
  // Terminal step for a Hot + finance lead: documents collected, consent signed.
  // Submitting surfaces the lead — documents, extracted details and consent — to
  // the admin KYC review queue in one shot, then clears the draft.
  const lead = await getLeadCtx(session);
  if (lead.leadId) {
    try {
      await ensureAdminKycQueueEntry(lead.leadId);
    } catch (e) {
      console.error("[WhatsApp/console] admin KYC queue entry failed:", e);
    }
  }

  const fresh = await loadSession(session.id);
  if (((fresh.context as Ctx)?.flow) === "customer") {
    return await finishCustomerFlow(
      session,
      "🎉 *Thanks! Your details have been submitted to iTarang for review.*\n\n" +
        "Your documents and signed consent have all been sent for verification. Our team will contact you shortly.",
    );
  }

  await mergeContext(session, (ctx) => {
    ctx.lead = undefined;
  });
  await setSession(session.id, { current_state: "DC_MENU" });

  await reply(
    session,
    "🎉 *Lead submitted to iTarang for KYC review!*\n\n" +
      "The customer's documents, extracted details and signed consent have all been sent for verification.\n\n" +
      "Send *menu* to create another lead.",
  );
}
