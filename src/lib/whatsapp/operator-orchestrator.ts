// E-214 — the internal onboarding OPERATOR console.
//
// PROBLEM THIS SOLVES. The onboarding bot supported exactly one dealer per
// WhatsApp number: getOrCreateSession() keyed identity on wa_phone and the row
// it returned was immortal (stop/restart reuse the same session AND the same
// application), so once that one application was approved every later message
// from the number went to the dealer lead console. iTarang's internal team needs
// each member to onboard MANY dealers from their own single number.
//
// HOW IT WORKS. wa_phone was never unique on whatsapp_onboarding_sessions, so an
// operator gets several rows:
//
//   operator_hub   — one per operator number. Holds the OP_* menu state and the
//                    "currently-open dealer file" pointer (ctx.op).
//   operator_file  — one per dealer file. Carries the OPERATOR's wa_phone (so
//                    reply() reaches them) while application_id points at that
//                    dealer's application.
//
// Because every onboarding handler reads and writes ONLY the session row it is
// handed, delegating to runOnboardingStates(fileSession, event) drives a full
// dealer onboarding — company type, the Gemini/Decentro document pipeline,
// fields, signer, confirm, submit — with zero changes to any of it. SUBMITTED
// becomes terminal per dealer FILE instead of per phone, which was the whole
// problem.
//
// This module imports orchestrator.ts statically; orchestrator.ts imports THIS
// one lazily (`await import`) inside the gate, so there is no module-eval cycle.

import { and, desc, eq, inArray, notInArray } from "drizzle-orm";

import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  whatsappOnboardingSessions,
} from "@/lib/db/schema";
import { notifyOnboardingChatStarted } from "@/lib/notifications/events";

import {
  PLACEHOLDER_COMPANY,
  askCompanyType,
  runConsoleTurn,
  runOnboardingStates,
} from "./orchestrator";
import { loadApplication } from "./customer-lead";
import { resolveWhatsAppDealer } from "./dealer-identity";
import { getAdapter } from "./index";
import type { WhatsAppOperator } from "./operator-identity";
import { toWaPhone } from "./operator-identity";
import {
  type Ctx,
  type SessionRow,
  attachInboundToSession,
  loadSession,
  mergeContext,
  reply,
  replyList,
  setSession,
} from "./session-store";
import type { InboundEvent, ListRow } from "./types";

// A dealer file is done (from the operator's point of view) once it reaches one
// of these. The operator is then bounced back to their menu to start the next.
const TERMINAL_FILE_STATES = new Set(["SUBMITTED", "REJECTED"]);

// Escapes back to the operator menu. Deliberately includes the global stop words
// (stop/end/exit): in operator mode those must NOT reach handleStop(), which
// wipes ctx.docs/answers on the row it is given — catastrophic mid-file.
const OP_ESCAPE = /^(hi+|hey+|hello+|helo|hii+|menu|start|home|back|#|namaste|stop|end|exit|restart)$/i;

const OP_MENU_ROWS: ListRow[] = [
  {
    id: "op_new_dealer",
    title: "🆕 New Dealer",
    description: "Start onboarding a new dealer",
  },
  {
    id: "op_open_files",
    title: "📂 Open Files",
    description: "Resume a dealer you started",
  },
  {
    id: "op_help",
    title: "❓ Help",
    description: "How this works",
  },
];

const DEALER_CONSOLE_ROW: ListRow = {
  id: "op_my_console",
  title: "🏪 My Dealer Console",
  description: "Your own dealer account",
};

const FILE_MENU_ROWS: ListRow[] = [
  {
    id: "opf_continue",
    title: "▶️ Continue",
    description: "Keep collecting for this dealer",
  },
  {
    id: "opf_invite",
    title: "📲 Invite Dealer",
    description: "Let the dealer upload from their own WhatsApp",
  },
  {
    id: "opf_restart",
    title: "♻️ Start Over",
    description: "Clear this file and begin again",
  },
  {
    id: "opf_close",
    title: "⬅️ Back to Menu",
    description: "Park this file for later",
  },
];

const PICK_PAGE_SIZE = 9;

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * One turn for an allowlisted internal operator. `hub` is their `operator_hub`
 * session row (see getOrCreateSession in orchestrator.ts).
 */
export async function runOperatorTurn(
  hub: SessionRow,
  event: InboundEvent,
  operator: WhatsAppOperator,
): Promise<void> {
  try {
    const ctx = (hub.context ?? {}) as Ctx;
    const text = (event.text ?? "").trim();
    const isEscape = event.type === "text" && OP_ESCAPE.test(text);

    // The operator is browsing their OWN dealer console (only possible when
    // their number is also an approved dealer). Hand the message straight over,
    // and let an escape word bring them back to the operator menu.
    if (ctx.op?.inDealerConsole && !isEscape) {
      const dealer = await resolveOwnDealer(hub, event.waPhone);
      if (dealer) return await runConsoleTurn(hub, event, dealer);
    }

    if (isEscape) {
      if (hub.current_state === "OP_FILE_ACTIVE" && ctx.op?.openFileSessionId) {
        return await showFileMenu(hub, operator);
      }
      return await showOperatorMenu(hub, operator);
    }

    switch (hub.current_state) {
      case "OP_MENU":
        return await onMenuChoice(hub, event, operator);
      case "OP_NEW_PHONE":
        return await onNewDealerPhone(hub, event, operator);
      case "OP_NEW_NAME":
        return await onNewDealerName(hub, event, operator);
      case "OP_PICK_DEALER":
        return await onPickDealer(hub, event, operator);
      case "OP_FILE_MENU":
        return await onFileMenuChoice(hub, event, operator);
      case "OP_FILE_HANDED_OFF":
        return await onHandedOffChoice(hub, event, operator);
      case "OP_FILE_ACTIVE":
        return await delegateToFile(hub, event, operator);
      default:
        // Any leftover state (including a pre-E-214 dealer state, if this number
        // used to onboard as a dealer) drops back to the operator menu.
        return await showOperatorMenu(hub, operator);
    }
  } catch (err) {
    console.error("[WhatsApp/operator] turn failed:", err);
    await reply(
      hub,
      "Sorry, something went wrong on our side. Please try again in a moment.",
    );
  }
}

// ── Menu ────────────────────────────────────────────────────────────────────

async function showOperatorMenu(
  hub: SessionRow,
  operator: WhatsAppOperator,
): Promise<void> {
  const openCount = await countOpenFiles(operator.id);
  const rows = [...OP_MENU_ROWS];

  // Only offer the dealer console when this number really is an approved dealer
  // — otherwise the operator gate would have locked them out of their own shop.
  const ownDealer = await resolveWhatsAppDealer(hub.wa_phone).catch(() => null);
  if (ownDealer?.dealerUserId) rows.push(DEALER_CONSOLE_ROW);

  await mergeContext(hub, (ctx) => {
    ctx.op = { ...(ctx.op ?? {}), operatorId: operator.id };
    ctx.op.openFileSessionId = undefined;
    ctx.op.openApplicationId = undefined;
    ctx.op.draft = undefined;
    ctx.op.pickPage = 0;
    ctx.op.inDealerConsole = false;
  });
  await setSession(hub.id, {
    current_state: "OP_MENU",
    application_id: null,
    expected_document_type: null,
    detected_company_type: null,
    session_status: "active",
  });

  const summary = openCount
    ? `You have *${openCount}* open dealer file${openCount === 1 ? "" : "s"}.`
    : "No open dealer files right now.";

  await replyList(
    await loadSession(hub.id),
    `👋 Hi *${operator.displayName}*!\n\n${summary}\n\nWhat would you like to do?`,
    "Choose",
    rows,
  );
}

async function onMenuChoice(
  hub: SessionRow,
  event: InboundEvent,
  operator: WhatsAppOperator,
): Promise<void> {
  const choice = (event.text ?? "").trim().toLowerCase();

  if (choice === "op_new_dealer" || /^(new|1)$/.test(choice)) {
    await setSession(hub.id, { current_state: "OP_NEW_PHONE" });
    return await reply(
      await loadSession(hub.id),
      "🆕 *New dealer*\n\nWhat is the dealer's own WhatsApp number? " +
        "Credentials and, if you hand the file over, the document requests go there.\n\n" +
        "Send the 10-digit mobile number.",
    );
  }

  if (choice === "op_open_files" || /^(open|drafts?|2)$/.test(choice)) {
    return await showOpenFiles(hub, operator, 0);
  }

  if (choice === "op_my_console") {
    const dealer = await resolveOwnDealer(hub, hub.wa_phone);
    if (!dealer) {
      await reply(hub, "This number isn't linked to an active dealer account.");
      return await showOperatorMenu(hub, operator);
    }
    await mergeContext(hub, (ctx) => {
      ctx.op = { ...(ctx.op ?? {}), operatorId: operator.id };
      ctx.op.inDealerConsole = true;
    });
    await reply(
      hub,
      "Switching to your *dealer console*. Type *menu* any time to come back to onboarding.",
    );
    return await runConsoleTurn(await loadSession(hub.id), event, dealer);
  }

  if (choice === "op_help" || /^(help|3)$/.test(choice)) {
    await reply(hub, helpText());
    return await showOperatorMenu(hub, operator);
  }

  return await showOperatorMenu(hub, operator);
}

function helpText(): string {
  return (
    "*How onboarding over WhatsApp works*\n\n" +
    "1️⃣ *New Dealer* — give me the dealer's own WhatsApp number and name. " +
    "I open a fresh file for them.\n" +
    "2️⃣ Send me their documents right here (GST, PAN, bank cheque, Udyam…). " +
    "I read each one and fill the application.\n" +
    "3️⃣ Or tap *Invite Dealer* on the file menu and the dealer uploads from " +
    "their own WhatsApp instead.\n" +
    "4️⃣ When the file is complete I submit it to the Sales Admin, and you go " +
    "straight back to this menu to start the next dealer.\n\n" +
    "You can run as many dealer files as you like from this one number — " +
    "*Open Files* resumes any of them.\n\n" +
    "Type *menu* at any point to come back here."
  );
}

// ── New dealer file ─────────────────────────────────────────────────────────

async function onNewDealerPhone(
  hub: SessionRow,
  event: InboundEvent,
  operator: WhatsAppOperator,
): Promise<void> {
  const waPhone = toWaPhone(event.text ?? "");
  if (!waPhone) {
    return await reply(
      hub,
      "That doesn't look like a valid mobile number. Send the dealer's 10-digit WhatsApp number.",
    );
  }

  // Don't let an operator start a file on a number that already belongs to a
  // live dealer — that number is already an identity in the system.
  const existingDealer = await resolveWhatsAppDealer(waPhone).catch(() => null);
  if (existingDealer) {
    await reply(
      hub,
      `⚠️ *${waPhone}* is already an active dealer (${existingDealer.dealerName ?? existingDealer.dealerCode}). ` +
        "Send a different number, or type *menu* to go back.",
    );
    return;
  }

  await mergeContext(hub, (ctx) => {
    ctx.op = { ...(ctx.op ?? {}), operatorId: operator.id };
    ctx.op.draft = { dealerWaPhone: waPhone };
  });
  await setSession(hub.id, { current_state: "OP_NEW_NAME" });
  await reply(
    await loadSession(hub.id),
    "Got it. What should I call this dealer? (Owner or shop name — just so you " +
      "can find the file later; the real name comes from their documents.)",
  );
}

async function onNewDealerName(
  hub: SessionRow,
  event: InboundEvent,
  operator: WhatsAppOperator,
): Promise<void> {
  const name = (event.text ?? "").trim();
  if (name.length < 2) {
    return await reply(hub, "Please send a name I can label this file with.");
  }

  const ctx = (hub.context ?? {}) as Ctx;
  const dealerWaPhone = ctx.op?.draft?.dealerWaPhone;
  if (!dealerWaPhone) {
    // Lost the draft (e.g. context wiped) — restart the two questions.
    await setSession(hub.id, { current_state: "OP_NEW_PHONE" });
    return await reply(
      hub,
      "I lost track of that — what is the dealer's WhatsApp number?",
    );
  }

  await openFile(hub, operator, { dealerWaPhone, dealerName: name });
}

/**
 * Create a dealer application + its `operator_file` session and hand control to
 * the ordinary onboarding state machine.
 */
async function openFile(
  hub: SessionRow,
  operator: WhatsAppOperator,
  params: { dealerWaPhone: string; dealerName: string },
): Promise<void> {
  const { dealerWaPhone, dealerName } = params;

  // Reuse rather than duplicate: an operator who re-enters the same number gets
  // the file they already started.
  const existing = await findOpenFileForPhone(operator.id, dealerWaPhone);
  if (existing) {
    await reply(
      hub,
      `You already have an open file for *${dealerWaPhone}* — resuming it.`,
    );
    return await activateFile(hub, existing.session, existing.application, {
      resume: true,
    });
  }

  const [application] = await db
    .insert(dealerOnboardingApplications)
    .values({
      // company_name is NOT NULL; the operator's label is a better placeholder
      // than the generic one and is overwritten once the GST is read.
      company_name: dealerName || PLACEHOLDER_COMPANY,
      owner_name: dealerName || null,
      source: "whatsapp",
      // ALWAYS the dealer's own number — never the operator's. This is the
      // credentials destination and the key resolveWhatsAppDealer() matches on.
      wa_phone: dealerWaPhone,
      onboarding_operator_id: operator.id,
      onboarding_channel: "operator",
      onboarding_status: "draft",
      review_status: "draft",
      agreement_status: "not_generated",
      stamp_status: "pending",
      completion_status: "pending",
    })
    .returning();

  const [fileSession] = await db
    .insert(whatsappOnboardingSessions)
    .values({
      // The OPERATOR's number: every reply for this file goes to them.
      wa_phone: hub.wa_phone,
      wa_contact_name: dealerName,
      provider: getAdapter().provider,
      provider_conversation_id: hub.provider_conversation_id,
      application_id: application.id,
      session_kind: "operator_file",
      operator_id: operator.id,
      parent_session_id: hub.id,
      current_state: "GREETING",
      session_status: "active",
      last_inbound_at: new Date(),
    })
    .returning();

  await db
    .update(dealerOnboardingApplications)
    .set({ wa_operator_session_id: fileSession.id, updated_at: new Date() })
    .where(eq(dealerOnboardingApplications.id, application.id));

  // One "chat started" signal per real dealer (the hub greeting fires none).
  await notifyOnboardingChatStarted({
    phone: dealerWaPhone,
    sessionId: fileSession.id,
  }).catch((err) =>
    console.error("[WhatsApp/operator] chat-started notify failed:", err),
  );

  await activateFile(hub, fileSession, application, { resume: false });
}

/** Point the hub at a file row and start/resume the onboarding machine. */
async function activateFile(
  hub: SessionRow,
  fileSession: SessionRow,
  application: { id: string; company_name: string | null; wa_phone: string | null },
  opts: { resume: boolean },
): Promise<void> {
  await mergeContext(hub, (ctx) => {
    ctx.op = { ...(ctx.op ?? {}) } as NonNullable<Ctx["op"]>;
    ctx.op.openFileSessionId = fileSession.id;
    ctx.op.openApplicationId = application.id;
    ctx.op.draft = undefined;
  });
  await setSession(hub.id, {
    current_state: "OP_FILE_ACTIVE",
    application_id: application.id,
  });

  const label = application.company_name || application.wa_phone || "this dealer";
  await reply(
    await loadSession(hub.id),
    opts.resume
      ? `📂 *${label}* is open again. Type *menu* for file options.`
      : `📂 Opened a file for *${label}* (${application.wa_phone}).\n\n` +
          "Send their documents here as you get them. Type *menu* any time for " +
          "file options — including handing the upload over to the dealer.",
  );

  const fresh = await loadSession(fileSession.id);

  // A file that hasn't got past the entry states goes straight to the
  // company-type question. Replaying a greeting there would surface the
  // "are you a customer or a dealer?" chooser — the operator has already told us
  // this is a dealer, and CHOOSE_FLOW is outside the states delegateToFile
  // expects, so the file would stall.
  if (!opts.resume || ENTRY_STATES.has(fresh.current_state)) {
    await askCompanyType(fresh);
    return;
  }

  // Mid-file: a greeting is the one input every remaining state handles —
  // hasOnboardingProgress()/RESUMABLE_STATES turn it into the Resume/Start-Over
  // ask, and the rest simply re-prompt for whatever they were waiting on.
  await runOnboardingStates(fresh, syntheticGreeting(hub));
}

/** File states that predate the dealer-onboarding questions proper. */
const ENTRY_STATES = new Set(["GREETING", "CHOOSE_FLOW", "GENERAL_INFO"]);

/**
 * Clear a dealer file and start it again from the company-type question.
 *
 * Deliberately NOT restartOnboarding(), which ends at onGreeting() → the
 * "are you a customer or a dealer?" entry chooser. An operator has already told
 * us this file is a dealer; sending them through the role ask would be noise and
 * would leave the file in CHOOSE_FLOW, outside the states delegateToFile expects.
 */
async function restartFile(fileSession: SessionRow): Promise<void> {
  await mergeContext(fileSession, (ctx) => {
    ctx.docs = {};
    ctx.answers = {};
    ctx.fieldIndex = 0;
    ctx.skipped = [];
    ctx.attempts = {};
    ctx.resumeState = undefined;
  });
  await setSession(fileSession.id, {
    detected_company_type: null,
    expected_document_type: null,
    session_status: "active",
  });
  await askCompanyType(
    await loadSession(fileSession.id),
    "♻️ Starting this dealer's file again.",
  );
}

/**
 * A synthetic "hi" used to re-prompt a resumed file. It never reaches the
 * provider — only the state handlers read it — but recordInbound() has already
 * stored the operator's real message, so we must NOT reuse its
 * providerMessageId (the UNIQUE index would reject a second insert).
 */
function syntheticGreeting(hub: SessionRow): InboundEvent {
  return {
    providerMessageId: `internal-resume-${hub.id}`,
    waPhone: hub.wa_phone,
    type: "text",
    text: "hi",
    raw: { synthetic: "operator_resume" },
  };
}

// ── Delegation to the dealer-onboarding state machine ───────────────────────

async function delegateToFile(
  hub: SessionRow,
  event: InboundEvent,
  operator: WhatsAppOperator,
): Promise<void> {
  const ctx = (hub.context ?? {}) as Ctx;
  const fileSessionId = ctx.op?.openFileSessionId;
  if (!fileSessionId) return await showOperatorMenu(hub, operator);

  const file = await loadSession(fileSessionId);
  if (!file) return await showOperatorMenu(hub, operator);

  await setSession(file.id, { last_inbound_at: new Date() });
  // Re-attribute the inbound row from the hub to THIS dealer's file, so the
  // admin transcript shows the message on the conversation it belongs to.
  await attachInboundToSession(event.providerMessageId, file.id);
  await runOnboardingStates(file, event);

  // The file may have reached SUBMITTED (or been rejected mid-flow) — in which
  // case SUBMITTED is terminal for THAT DEALER, not for this phone.
  const after = await loadSession(file.id);
  if (after && TERMINAL_FILE_STATES.has(after.current_state)) {
    await closeFile(hub, after, operator);
  }
}

/**
 * A dealer file finished. Park it and return the operator to their menu so they
 * can start the next dealer immediately — this is what replaces the old
 * "SUBMITTED is terminal for this number, forever" behaviour.
 */
async function closeFile(
  hub: SessionRow,
  fileSession: SessionRow,
  operator: WhatsAppOperator,
): Promise<void> {
  const application = await loadApplication(fileSession.application_id);
  const label =
    application?.company_name || application?.wa_phone || "That dealer";

  const submitted = fileSession.current_state === "SUBMITTED";
  const total = await countSubmittedFiles(operator.id);

  await reply(
    hub,
    submitted
      ? `✅ *${label}* has been submitted for review.` +
          (total ? `\n\nThat's *${total}* submitted so far. 👏` : "")
      : `📕 *${label}* is closed.`,
  );

  // Clear the onboarding leftovers off the HUB. The file row keeps its own
  // context untouched — it is the audit trail and the transcript viewer's source.
  await mergeContext(hub, (ctx) => {
    ctx.docs = {};
    ctx.answers = {};
    ctx.fieldIndex = undefined;
    ctx.skipped = [];
    ctx.attempts = {};
    ctx.op = { ...(ctx.op ?? {}), operatorId: operator.id };
    ctx.op.openFileSessionId = undefined;
    ctx.op.openApplicationId = undefined;
  });

  await showOperatorMenu(await loadSession(hub.id), operator);
}

// ── File menu ───────────────────────────────────────────────────────────────

async function showFileMenu(
  hub: SessionRow,
  operator: WhatsAppOperator,
): Promise<void> {
  const ctx = (hub.context ?? {}) as Ctx;
  const application = await loadApplication(ctx.op?.openApplicationId ?? null);
  if (!application) return await showOperatorMenu(hub, operator);

  await setSession(hub.id, { current_state: "OP_FILE_MENU" });
  await replyList(
    await loadSession(hub.id),
    `📂 *${application.company_name || application.wa_phone}*\n` +
      `Dealer WhatsApp: ${application.wa_phone ?? "—"}\n\n` +
      "What next?",
    "File options",
    FILE_MENU_ROWS,
  );
}

async function onFileMenuChoice(
  hub: SessionRow,
  event: InboundEvent,
  operator: WhatsAppOperator,
): Promise<void> {
  const choice = (event.text ?? "").trim().toLowerCase();
  const ctx = (hub.context ?? {}) as Ctx;
  const fileSessionId = ctx.op?.openFileSessionId;
  const applicationId = ctx.op?.openApplicationId;

  if (!fileSessionId || !applicationId) {
    return await showOperatorMenu(hub, operator);
  }

  // Typed fallbacks alongside the list-row ids: an operator on a client that
  // doesn't render interactive lists (or who just prefers typing) must still be
  // able to drive every action. Mirrors onMenuChoice.
  if (choice === "opf_close" || /^(close|park|4)$/.test(choice)) {
    return await showOperatorMenu(hub, operator);
  }

  if (choice === "opf_continue" || /^(continue|resume|1)$/.test(choice)) {
    await setSession(hub.id, { current_state: "OP_FILE_ACTIVE" });
    // NOT `event` — that is the menu tap ("opf_continue"), which a document or
    // field state would try to parse as the operator's answer. Re-prompt instead.
    await runOnboardingStates(
      await loadSession(fileSessionId),
      syntheticGreeting(hub),
    );
    return;
  }

  if (choice === "opf_restart" || /^(restart|start ?over|3)$/.test(choice)) {
    await setSession(hub.id, { current_state: "OP_FILE_ACTIVE" });
    await restartFile(await loadSession(fileSessionId));
    return;
  }

  if (choice === "opf_invite" || /^(invite|handoff|hand ?over|2)$/.test(choice)) {
    const application = await loadApplication(applicationId);
    if (!application?.wa_phone) {
      await reply(hub, "This file has no dealer WhatsApp number to invite.");
      return await showFileMenu(hub, operator);
    }
    const { inviteDealerToApplication } = await import("./operator-handoff");
    const res = await inviteDealerToApplication({
      applicationId,
      dealerWaPhone: application.wa_phone,
      dealerName: application.owner_name || application.company_name || null,
      operatorFileSessionId: fileSessionId,
    });
    if (!res.ok) {
      await reply(
        hub,
        `Couldn't message the dealer (${res.error ?? "unknown error"}). ` +
          "You can keep uploading here instead.",
      );
      return await showFileMenu(hub, operator);
    }
    await setSession(hub.id, { current_state: "OP_FILE_HANDED_OFF" });
    return await replyList(
      await loadSession(hub.id),
      `📲 Invited *${application.wa_phone}* to upload their own documents.\n\n` +
        "I'll keep you posted. You can take the file back any time.",
      "Options",
      [
        {
          id: "opf_takeback",
          title: "↩️ Take Back",
          description: "Upload the documents yourself again",
        },
        {
          id: "opf_close",
          title: "⬅️ Back to Menu",
          description: "Start another dealer",
        },
      ],
    );
  }

  return await showFileMenu(hub, operator);
}

async function onHandedOffChoice(
  hub: SessionRow,
  event: InboundEvent,
  operator: WhatsAppOperator,
): Promise<void> {
  const choice = (event.text ?? "").trim().toLowerCase();
  const ctx = (hub.context ?? {}) as Ctx;

  if (
    (choice === "opf_takeback" || /^(take ?back|takeback|1)$/.test(choice)) &&
    ctx.op?.openApplicationId
  ) {
    await db
      .update(dealerOnboardingApplications)
      .set({ onboarding_channel: "operator", updated_at: new Date() })
      .where(eq(dealerOnboardingApplications.id, ctx.op.openApplicationId));
    await setSession(hub.id, { current_state: "OP_FILE_ACTIVE" });
    return await reply(
      await loadSession(hub.id),
      "↩️ File is back with you. Send the documents here.",
    );
  }

  return await showOperatorMenu(hub, operator);
}

// ── Open-files picker ───────────────────────────────────────────────────────

async function showOpenFiles(
  hub: SessionRow,
  operator: WhatsAppOperator,
  page: number,
): Promise<void> {
  const files = await listOpenFiles(operator.id, page);
  if (files.length === 0) {
    await reply(
      hub,
      page === 0
        ? "No open dealer files yet. Tap *New Dealer* to start one."
        : "That's all of them.",
    );
    return await showOperatorMenu(hub, operator);
  }

  const rows: ListRow[] = files.map((f) => ({
    id: `opfile_${f.sessionId}`,
    title: truncate(f.label, 24),
    description: truncate(
      `${f.dealerPhone ?? "—"} · ${stateLabel(f.state)}`,
      72,
    ),
  }));
  if (files.length === PICK_PAGE_SIZE) {
    rows.push({ id: "opfile_more", title: "➡️ More", description: "Next page" });
  }

  await mergeContext(hub, (ctx) => {
    ctx.op = { ...(ctx.op ?? {}), operatorId: operator.id };
    ctx.op.pickPage = page;
  });
  await setSession(hub.id, { current_state: "OP_PICK_DEALER" });
  await replyList(
    await loadSession(hub.id),
    "📂 *Your open dealer files*",
    "Pick a dealer",
    rows,
  );
}

async function onPickDealer(
  hub: SessionRow,
  event: InboundEvent,
  operator: WhatsAppOperator,
): Promise<void> {
  const choice = (event.text ?? "").trim();
  const ctx = (hub.context ?? {}) as Ctx;

  if (choice === "opfile_more") {
    return await showOpenFiles(hub, operator, (ctx.op?.pickPage ?? 0) + 1);
  }
  if (!choice.startsWith("opfile_")) {
    return await showOpenFiles(hub, operator, ctx.op?.pickPage ?? 0);
  }

  const sessionId = choice.slice("opfile_".length);
  const fileSession = await loadSession(sessionId);
  // Ownership check: never resume another operator's file from a guessed id.
  if (
    !fileSession ||
    fileSession.operator_id !== operator.id ||
    fileSession.session_kind !== "operator_file"
  ) {
    await reply(hub, "That file isn't available.");
    return await showOperatorMenu(hub, operator);
  }

  const application = await loadApplication(fileSession.application_id);
  if (!application) {
    await reply(hub, "That file's application is missing.");
    return await showOperatorMenu(hub, operator);
  }

  await activateFile(hub, fileSession, application, { resume: true });
}

// ── Queries ─────────────────────────────────────────────────────────────────

type OpenFile = {
  sessionId: string;
  applicationId: string;
  label: string;
  dealerPhone: string | null;
  state: string;
};

async function listOpenFiles(
  operatorId: string,
  page: number,
): Promise<OpenFile[]> {
  const rows = await db
    .select({
      sessionId: whatsappOnboardingSessions.id,
      state: whatsappOnboardingSessions.current_state,
      applicationId: dealerOnboardingApplications.id,
      companyName: dealerOnboardingApplications.company_name,
      ownerName: dealerOnboardingApplications.owner_name,
      dealerPhone: dealerOnboardingApplications.wa_phone,
    })
    .from(whatsappOnboardingSessions)
    .innerJoin(
      dealerOnboardingApplications,
      eq(
        dealerOnboardingApplications.id,
        whatsappOnboardingSessions.application_id,
      ),
    )
    .where(
      and(
        eq(whatsappOnboardingSessions.operator_id, operatorId),
        eq(whatsappOnboardingSessions.session_kind, "operator_file"),
        notTerminal(),
      ),
    )
    .orderBy(desc(whatsappOnboardingSessions.updated_at))
    .limit(PICK_PAGE_SIZE)
    .offset(page * PICK_PAGE_SIZE);

  return rows.map((r) => ({
    sessionId: r.sessionId,
    applicationId: r.applicationId,
    label: r.companyName || r.ownerName || r.dealerPhone || "Unnamed dealer",
    dealerPhone: r.dealerPhone,
    state: r.state,
  }));
}

/** Files the operator can still work on — i.e. not already submitted/rejected. */
function notTerminal() {
  return notInArray(whatsappOnboardingSessions.current_state, [
    ...TERMINAL_FILE_STATES,
  ]);
}

async function countOpenFiles(operatorId: string): Promise<number> {
  const rows = await db
    .select({ id: whatsappOnboardingSessions.id })
    .from(whatsappOnboardingSessions)
    .where(
      and(
        eq(whatsappOnboardingSessions.operator_id, operatorId),
        eq(whatsappOnboardingSessions.session_kind, "operator_file"),
        notTerminal(),
      ),
    );
  return rows.length;
}

async function countSubmittedFiles(operatorId: string): Promise<number> {
  const rows = await db
    .select({ id: dealerOnboardingApplications.id })
    .from(dealerOnboardingApplications)
    .where(
      and(
        eq(dealerOnboardingApplications.onboarding_operator_id, operatorId),
        inArray(dealerOnboardingApplications.onboarding_status, [
          "submitted",
          "approved",
        ]),
      ),
    );
  return rows.length;
}

async function findOpenFileForPhone(
  operatorId: string,
  dealerWaPhone: string,
): Promise<{
  session: SessionRow;
  application: {
    id: string;
    company_name: string | null;
    wa_phone: string | null;
  };
} | null> {
  const [row] = await db
    .select({
      session: whatsappOnboardingSessions,
      applicationId: dealerOnboardingApplications.id,
      companyName: dealerOnboardingApplications.company_name,
      appPhone: dealerOnboardingApplications.wa_phone,
    })
    .from(whatsappOnboardingSessions)
    .innerJoin(
      dealerOnboardingApplications,
      eq(
        dealerOnboardingApplications.id,
        whatsappOnboardingSessions.application_id,
      ),
    )
    .where(
      and(
        eq(whatsappOnboardingSessions.operator_id, operatorId),
        eq(whatsappOnboardingSessions.session_kind, "operator_file"),
        eq(dealerOnboardingApplications.wa_phone, dealerWaPhone),
        notTerminal(),
      ),
    )
    .orderBy(desc(whatsappOnboardingSessions.created_at))
    .limit(1);

  if (!row) return null;
  return {
    session: row.session,
    application: {
      id: row.applicationId,
      company_name: row.companyName,
      wa_phone: row.appPhone,
    },
  };
}

/**
 * The operator's OWN dealer account, when their number happens to be an approved
 * dealer too. Without this they'd be locked out of their shop by the operator
 * gate, which returns before the dealer-console gates in runTurn.
 *
 * Resolved from the PHONE only — deliberately never from hub.application_id.
 * That column is the "currently-open dealer FILE" pointer, so reading it here
 * would drop the operator into someone else's console the moment a dealer they
 * onboarded got approved, and let them create leads against a dealer they don't
 * own. Same trap the gate placement in runTurn guards against.
 */
async function resolveOwnDealer(hub: SessionRow, waPhone: string) {
  const own = await resolveWhatsAppDealer(waPhone).catch(() => null);
  if (!own?.dealerUserId) return null;
  return {
    dealerCode: own.dealerCode,
    uploaderId: own.dealerUserId,
    dealerName: own.dealerName || hub.wa_contact_name || "there",
    financeEnabled: own.financeEnabled,
  };
}

// ── Misc ────────────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function stateLabel(state: string): string {
  switch (state) {
    case "GREETING":
    case "CHOOSE_FLOW":
      return "not started";
    case "ASK_COMPANY_TYPE":
      return "company type";
    case "ASK_UPLOAD_MODE":
    case "COLLECTING_DOC":
      return "collecting documents";
    case "ASK_FINANCE":
    case "ASK_FIELD":
      return "answering questions";
    case "CONFIRM_SIGNER":
    case "ASK_SIGNER_CHOICE":
    case "ASK_SIGNER_FIELD":
      return "confirming signer";
    case "AWAIT_CONFIRM":
      return "awaiting confirmation";
    case "CORRECTION":
      return "corrections requested";
    default:
      return state.toLowerCase().replace(/_/g, " ");
  }
}
