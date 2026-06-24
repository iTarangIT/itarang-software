// E-170 — dealer self-service orchestrator (post-approval WhatsApp dashboard).
//
// Entry: runDealerTurn(event, dealer), called from orchestrator.ts runTurn AFTER
// resolveWhatsAppDealer() confirms the sender is an approved/active dealer. This
// is a SEPARATE state machine from onboarding (orchestrator.ts) with its own
// session table (whatsapp_dealer_sessions) so the two never collide on wa_phone.
//
// This first increment implements the dealer DASHBOARD: the menu and the three
// branches the dealer can reach any time — New Lead (entry), My Drafts, and
// Inventory — plus the global-command router that lets those work mid-flow. The
// full lead-capture + KYC + financing state handlers land in the next increments
// (plan Parts 3/4/10); their states are routed here to a clearly-marked stub.

import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { leads, whatsappDealerSessions, whatsappMessages } from "@/lib/db/schema";
import { getInventorySummary } from "@/lib/inventory/summary";
import {
  getLeadDraft,
  initializeDraftLead,
  saveLeadDraftFields,
} from "@/lib/leads/draftService";

import type { WhatsAppDealer } from "./dealer-identity";
import { getAdapter } from "./index";
import type { InboundEvent, ReplyButton } from "./types";

type DealerSession = typeof whatsappDealerSessions.$inferSelect;

// Menu button ids — echoed back as event.text when the dealer taps a button.
const BTN_NEW_LEAD = "dlr:new_lead";
const BTN_DRAFTS = "dlr:drafts";
const BTN_INVENTORY = "dlr:inventory";

const MENU_BUTTONS: ReplyButton[] = [
  { id: BTN_NEW_LEAD, title: "New Lead" },
  { id: BTN_DRAFTS, title: "My Drafts" },
  { id: BTN_INVENTORY, title: "Inventory" },
];

// Global-command triggers — checked EVERY turn, before the per-lead state
// machine, so a dealer can jump to the menu / drafts / inventory mid-capture
// without corrupting the active draft.
const MENU_TRIGGERS = /^(hi+|hey+|hello+|menu|start|namaste|dashboard)$/i;
const NEW_LEAD_TRIGGERS = /^(new\s*lead|create\s*lead|add\s*lead|lead)$/i;
const DRAFTS_TRIGGERS = /^(my\s*drafts?|drafts?|leads?)$/i;
const INVENTORY_TRIGGERS = /^(inventory|stock|stocks)$/i;
const CANCEL_TRIGGERS = /^(cancel|pause|stop)$/i;
const HELP_TRIGGERS = /^(help|\?|commands)$/i;

const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

// ── Public entry point ───────────────────────────────────────────────────────

/** Run one conversation turn for an approved dealer's message. */
export async function runDealerTurn(
  event: InboundEvent,
  dealer: WhatsAppDealer,
): Promise<void> {
  if (event.type === "status") return; // delivery receipts handled upstream

  const session = await getOrCreateDealerSession(event.waPhone, dealer);
  await setDealerSession(session.id, { last_inbound_at: new Date() });

  try {
    const text = (event.text ?? "").trim();

    // 1) Global commands (button ids OR typed keywords) — intercepted first.
    if (event.text === BTN_NEW_LEAD || NEW_LEAD_TRIGGERS.test(text)) {
      return await onNewLead(session, dealer);
    }
    if (event.text === BTN_DRAFTS || DRAFTS_TRIGGERS.test(text)) {
      return await onMyDrafts(session, dealer);
    }
    if (event.text === BTN_INVENTORY || INVENTORY_TRIGGERS.test(text)) {
      return await onInventory(session, dealer);
    }
    if (MENU_TRIGGERS.test(text)) {
      return await onMenu(session);
    }
    if (HELP_TRIGGERS.test(text)) {
      return await onHelp(session);
    }
    if (CANCEL_TRIGGERS.test(text)) {
      await setDealerSession(session.id, { current_state: "MENU" });
      return void (await dealerReply(
        session,
        "👍 Saved. Send *menu* any time to continue.",
        MENU_BUTTONS,
      ));
    }

    // 1b) Numeric reply right after "my drafts" → resume that draft.
    if (/^\d+$/.test(text)) {
      const idx = (session.context as any)?.draftIndex as string[] | undefined;
      if (Array.isArray(idx) && idx.length > 0) {
        const pick = Number(text) - 1;
        if (pick >= 0 && pick < idx.length) {
          return await resumeDraft(session, idx[pick]);
        }
      }
    }

    // 2) Otherwise route by current state.
    switch (session.current_state) {
      case "MENU":
        return await onMenu(session);
      case "CAP_NAME":
        return await onCaptureName(session, text);
      case "CAP_MOBILE":
        return await onCaptureMobile(session, text);
      case "CAP_EMAIL":
        return await onCaptureEmail(session, text);
      case "CAP_ADDRESS":
        return await onCaptureAddress(session, text);
      // KYC / financing states (plan Parts 4/10) — not in this increment.
      default:
        return await onCaptureStub(session);
    }
  } catch (err) {
    console.error("[WhatsApp/dealer-orchestrator] turn failed:", err);
    await dealerReply(
      session,
      "Sorry, something went wrong on our side. Please try again in a moment.",
    );
  }
}

// ── State / command handlers ─────────────────────────────────────────────────

async function onMenu(session: DealerSession): Promise<void> {
  await setDealerSession(session.id, { current_state: "MENU" });
  await dealerReply(
    session,
    "👋 *iTarang Dealer* — what would you like to do?",
    MENU_BUTTONS,
  );
}

async function onHelp(session: DealerSession): Promise<void> {
  await dealerReply(
    session,
    [
      "*iTarang Dealer — WhatsApp commands*",
      "",
      "• *new lead* — create a new customer lead",
      "• *my drafts* — resume a lead you started",
      "• *inventory* — check your available stock",
      "• *menu* — show the main menu",
      "• *cancel* — pause and save your current lead",
    ].join("\n"),
  );
}

async function onInventory(
  session: DealerSession,
  dealer: WhatsAppDealer,
): Promise<void> {
  const s = await getInventorySummary({ dealerId: dealer.dealerCode });
  const lines = [
    `📦 *Your stock* — ${s.availableUnits} available (${INR.format(
      s.stockValue,
    )})`,
    `Reserved: ${s.reservedUnits} · Sold: ${s.soldUnits}`,
  ];
  if (s.availableUnits === 0) {
    lines.push("", "No available stock right now.");
  }
  await dealerReply(session, lines.join("\n"), MENU_BUTTONS);
}

async function onMyDrafts(
  session: DealerSession,
  dealer: WhatsAppDealer,
): Promise<void> {
  // Same rows the portal "My Drafts" lists: this dealer's leads still in draft.
  const rows = await db
    .select({
      id: leads.id,
      reference_id: leads.reference_id,
      full_name: leads.full_name,
      owner_name: leads.owner_name,
      owner_contact: leads.owner_contact,
      phone: leads.phone,
      updated_at: leads.updated_at,
    })
    .from(leads)
    .where(
      and(eq(leads.dealer_id, dealer.dealerCode), eq(leads.kyc_status, "draft")),
    )
    .orderBy(desc(leads.updated_at))
    .limit(10);

  if (rows.length === 0) {
    return void (await dealerReply(
      session,
      "📝 You have no saved drafts. Send *new lead* to start one.",
      MENU_BUTTONS,
    ));
  }

  const list = rows.map((r, i) => {
    const name = r.full_name || r.owner_name || "Unnamed customer";
    const ref = r.reference_id ? ` (${r.reference_id})` : "";
    const ph = r.phone || r.owner_contact || "";
    return `${i + 1}. ${name}${ref}${ph ? ` — ${ph}` : ""}`;
  });

  // Map list index → leadId so a reply of "1"/"2"… resumes that draft.
  await mergeDealerContext(session, (ctx) => {
    ctx.draftIndex = rows.map((r) => r.id);
  });

  await dealerReply(
    session,
    [
      "📝 *Your draft leads* — reply a number to resume:",
      "",
      ...list,
    ].join("\n"),
  );
}

async function onNewLead(
  session: DealerSession,
  dealer: WhatsAppDealer,
): Promise<void> {
  // Create (or resume) a real INCOMPLETE draft lead, then collect Step-1 fields
  // one per turn, autosaving each. The draft appears in "My Drafts" here AND in
  // the portal, where product/payment can be completed (plan: drafts are shared).
  const draft = await initializeDraftLead({
    dealerCode: dealer.dealerCode,
    dealerUserId: dealer.dealerUserId,
  });
  await setDealerSession(session.id, {
    active_lead_id: draft.leadId,
    current_state: "CAP_NAME",
  });
  const ref = draft.referenceId ? ` (${draft.referenceId})` : "";
  await dealerReply(
    session,
    draft.resumed
      ? `🔁 Resuming your open draft${ref}. What's the customer's *full name*?`
      : `🆕 *New lead*${ref}. What's the customer's *full name*?`,
  );
}

// ── Step-1 capture: name → mobile → email → address (autosave each turn) ──────

async function onCaptureName(
  session: DealerSession,
  text: string,
): Promise<void> {
  const name = text.trim();
  if (name.length < 2) {
    return void (await dealerReply(
      session,
      "Please type the customer's full name (at least 2 characters).",
    ));
  }
  if (!session.active_lead_id) return await onMenu(session);
  await saveLeadDraftFields(session.active_lead_id, { full_name: name });
  await setDealerSession(session.id, { current_state: "CAP_MOBILE" });
  await dealerReply(session, `Got it — *${name}*. Customer's *mobile number*?`);
}

async function onCaptureMobile(
  session: DealerSession,
  text: string,
): Promise<void> {
  const digits = text.replace(/\D/g, "");
  const ok = digits.length === 10 || (digits.length === 12 && digits.startsWith("91"));
  if (!ok) {
    return void (await dealerReply(
      session,
      "Please send a valid 10-digit mobile number.",
    ));
  }
  if (!session.active_lead_id) return await onMenu(session);
  await saveLeadDraftFields(session.active_lead_id, { phone: text });
  await setDealerSession(session.id, { current_state: "CAP_EMAIL" });
  await dealerReply(
    session,
    "Customer's *email*? (needed for the loan agreement) — or type *skip*.",
  );
}

async function onCaptureEmail(
  session: DealerSession,
  text: string,
): Promise<void> {
  if (!session.active_lead_id) return await onMenu(session);
  const v = text.trim();
  if (!/^skip$/i.test(v)) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      return void (await dealerReply(
        session,
        "That doesn't look like a valid email. Please re-enter it, or type *skip*.",
      ));
    }
    await saveLeadDraftFields(session.active_lead_id, { email: v });
  }
  await setDealerSession(session.id, { current_state: "CAP_ADDRESS" });
  await dealerReply(session, "Customer's *current address*? — or type *skip*.");
}

async function onCaptureAddress(
  session: DealerSession,
  text: string,
): Promise<void> {
  if (!session.active_lead_id) return await onMenu(session);
  const v = text.trim();
  if (!/^skip$/i.test(v) && v.length > 0) {
    await saveLeadDraftFields(session.active_lead_id, { current_address: v });
  }
  await setDealerSession(session.id, { current_state: "MENU" });
  await dealerReply(
    session,
    [
      "✅ *Draft saved.* It's in *My Drafts* on WhatsApp and in your dealer portal.",
      "",
      "Finish product, payment & KYC in the portal — or send *my drafts* to resume here.",
    ].join("\n"),
    MENU_BUTTONS,
  );
}

/** Resume an existing draft: point the session at it and jump to the next
 *  missing Step-1 field. */
async function resumeDraft(
  session: DealerSession,
  leadId: string,
): Promise<void> {
  const lead = await getLeadDraft(leadId);
  if (!lead) {
    return void (await dealerReply(
      session,
      "That draft is no longer available. Send *my drafts* for the current list.",
      MENU_BUTTONS,
    ));
  }
  const next = nextCaptureState(lead);
  await setDealerSession(session.id, {
    active_lead_id: leadId,
    current_state: next.state,
  });
  const who = lead.full_name || lead.owner_name || "this customer";
  await dealerReply(session, `🔁 Resuming *${who}*. ${next.prompt}`);
}

function nextCaptureState(lead: {
  full_name: string | null;
  phone: string | null;
  owner_email: string | null;
  current_address: string | null;
}): { state: string; prompt: string } {
  if (!lead.full_name || lead.full_name === "DRAFT")
    return { state: "CAP_NAME", prompt: "What's the customer's *full name*?" };
  if (!lead.phone)
    return { state: "CAP_MOBILE", prompt: "Customer's *mobile number*?" };
  if (!lead.owner_email)
    return { state: "CAP_EMAIL", prompt: "Customer's *email*? — or type *skip*." };
  if (!lead.current_address)
    return { state: "CAP_ADDRESS", prompt: "Customer's *current address*? — or type *skip*." };
  return {
    state: "MENU",
    prompt: "All Step-1 details are saved — finish product & payment in the portal.",
  };
}

async function onCaptureStub(session: DealerSession): Promise<void> {
  // Reached only for KYC / financing states not in this increment.
  await dealerReply(
    session,
    "✍️ This step is being finalised. Your *drafts* and *inventory* are live — send *menu*.",
    MENU_BUTTONS,
  );
}

// ── Session + reply helpers ──────────────────────────────────────────────────

async function getOrCreateDealerSession(
  waPhone: string,
  dealer: WhatsAppDealer,
): Promise<DealerSession> {
  const existing = await db
    .select()
    .from(whatsappDealerSessions)
    .where(eq(whatsappDealerSessions.wa_phone, waPhone))
    .orderBy(desc(whatsappDealerSessions.created_at))
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0];
    // Keep identity fresh (e.g. a dealer_code/user resolved later than first contact).
    if (
      row.dealer_code !== dealer.dealerCode ||
      row.dealer_user_id !== (dealer.dealerUserId ?? null)
    ) {
      await setDealerSession(row.id, {
        dealer_code: dealer.dealerCode,
        dealer_user_id: dealer.dealerUserId ?? null,
      });
      row.dealer_code = dealer.dealerCode;
      row.dealer_user_id = dealer.dealerUserId ?? null;
    }
    return row;
  }

  const [created] = await db
    .insert(whatsappDealerSessions)
    .values({
      wa_phone: waPhone,
      dealer_code: dealer.dealerCode,
      dealer_user_id: dealer.dealerUserId ?? null,
      current_state: "MENU",
      session_status: "active",
      last_inbound_at: new Date(),
    })
    .returning();
  return created;
}

async function setDealerSession(
  id: string,
  patch: Partial<DealerSession>,
): Promise<void> {
  await db
    .update(whatsappDealerSessions)
    .set({ ...patch, updated_at: new Date() } as any)
    .where(eq(whatsappDealerSessions.id, id));
}

/** Read-modify-write the dealer session context jsonb. */
async function mergeDealerContext(
  session: DealerSession,
  mutate: (ctx: Record<string, any>) => void,
): Promise<void> {
  const [fresh] = await db
    .select({ context: whatsappDealerSessions.context })
    .from(whatsappDealerSessions)
    .where(eq(whatsappDealerSessions.id, session.id))
    .limit(1);
  const ctx = ((fresh?.context ?? {}) as Record<string, any>) || {};
  mutate(ctx);
  await db
    .update(whatsappDealerSessions)
    .set({ context: ctx as any, updated_at: new Date() })
    .where(eq(whatsappDealerSessions.id, session.id));
}

/** Send a reply to the dealer and log it (mirrors orchestrator.ts reply()). */
async function dealerReply(
  session: DealerSession,
  body: string,
  buttons?: ReplyButton[],
): Promise<void> {
  const adapter = getAdapter();
  const res = buttons
    ? await adapter.sendInteractive(session.wa_phone, body, buttons)
    : await adapter.sendText(session.wa_phone, body);

  await db.insert(whatsappMessages).values({
    dealer_session_id: session.id,
    provider_message_id: res.providerMessageId,
    direction: "outbound",
    message_type: buttons ? "interactive" : "text",
    text_body: body,
    delivery_status: res.ok ? "sent" : "failed",
    raw_payload: (res.raw ?? null) as any,
  });
  await setDealerSession(session.id, { last_outbound_at: new Date() });
}
