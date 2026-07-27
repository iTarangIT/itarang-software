// Session row access + outbound messaging for the WhatsApp state machines.
//
// Extracted from orchestrator.ts (E-214) so the operator state machine can share
// them without importing the 5k-line orchestrator at module-eval time. Nothing
// here imports orchestrator.ts — the dependency runs one way only.
//
// A session row is the unit of conversation state. `wa_phone` is the DESTINATION
// for every reply, which is what makes the operator design work: an
// `operator_file` row carries the OPERATOR's number while its `application_id`
// points at a dealer's file, so the existing onboarding handlers drive a dealer
// application while the operator receives the replies.

import { eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  whatsappMessages,
  whatsappOnboardingSessions,
} from "@/lib/db/schema";

import { getAdapter } from "./index";
import type { ListRow, ReplyButton } from "./types";

export type SessionRow = typeof whatsappOnboardingSessions.$inferSelect;

export type Ctx = {
  answers?: Record<string, unknown>;
  docs?: Record<string, { fields: Record<string, unknown>; confidence: number }>;
  fieldIndex?: number;
  /** Index into SIGNER_FIELDS while the dealer is re-entering the signer
   *  (owner) name/phone/email via the "Change" button on the signer confirm. */
  signerIndex?: number;
  /** True when the dealer is editing a SINGLE signer field (picked Name/Email/
   *  Phone from the "Change" menu). After collecting that one field we loop back
   *  to the signer confirmation instead of walking through the remaining fields. */
  signerSingleEdit?: boolean;
  /** Document types the dealer couldn't provide / we gave up on — handled by the
   *  admin instead, so the flow doesn't get stuck. */
  skipped?: string[];
  /** Per-document failed-attempt counter, to auto-skip after a few bad tries. */
  attempts?: Record<string, number>;
  /** Active in-chat correction round (set when the admin requests corrections on
   *  a WhatsApp-onboarded dealer). The dealer fixes only the queued items. */
  correction?: {
    roundId: string;
    roundNumber: number;
    /** Ordered items to fix — fields first, then documents. `key` is the
     *  correction-catalog key (camelCase field / web doc key). */
    queue: Array<{ kind: "field" | "document"; key: string }>;
    /** Index into `queue` of the item we're currently collecting. */
    index: number;
  };
  /** When set, this session is a CUSTOMER self-onboarding a lead (entry-chooser
   *  option 2) rather than dealer onboarding. Routes to runCustomerTurn and
   *  attributes the created lead to the house dealer (dealer@itarang.com). */
  flow?: "customer";
  /** Active "General Information" Q&A (entry-chooser option 3). `turns` caps
   *  the LLM spend per session; `history` (last few Q/A pairs, answers
   *  truncated) gives follow-up questions their context. */
  info?: { turns: number; history: Array<{ q: string; a: string }> };
  /** The onboarding state we interrupted with the Resume/Start-Over prompt
   *  (ASK_RESUME); restored verbatim when the applicant taps Resume. */
  resumeState?: string;
  /** Recognized-contact stamp from the greeting-time phone lookup (staff /
   *  existing lead), kept for reuse so we don't re-query every greeting. */
  known?: { kind: "staff" | "lead"; name: string; role?: string };
  /** Active customer-lead being created in the post-approval dealer console
   *  (states prefixed DC_*). Independent of the onboarding fields above. */
  lead?: {
    leadId?: string;
    mobile?: string;
    /** Customer name established from the first ID document (Aadhaar/PAN); used
     *  to reject a later ID that belongs to a different person. */
    customerName?: string;
    interest?: "hot" | "warm" | "cold";
    paymentMethod?: "finance" | "cash" | "other_finance";
    /** Customer KYC document types collected so far (DC_LEAD_DOCS). */
    docs?: Record<string, true>;
    /** The product list offered at DC_LEAD_PRODUCT, so a tapped row resolves
     *  back to its catalogue ids. */
    productOptions?: Array<{
      productId: string;
      categoryId: string;
      name: string;
      assetType: string | null;
    }>;
    /** Index into ADDITIONAL_FINANCE_QUESTIONS while collecting the post-consent
     *  resident-status / health- / life-insurance answers (DC_LEAD_FINANCE_Q). */
    financeQIndex?: number;
    /** Wrong-OTP attempts on the current consent OTP session (DC_LEAD_CONSENT_OTP_WAIT). */
    consentOtpAttempts?: number;
    /** Channel the consent OTP was sent over, so Resend uses the same one. */
    consentOtpChannel?: "call" | "sms" | "whatsapp";
  };
  /** E-214 — internal onboarding operator state. Lives ONLY on the
   *  `operator_hub` row; the per-dealer `operator_file` rows carry ordinary
   *  onboarding context (answers/docs/…) so the existing handlers are reused
   *  unchanged. `openFileSessionId` is the "currently-open dealer file" pointer. */
  op?: {
    operatorId: string;
    /** whatsapp_onboarding_sessions.id of the open `operator_file` row. */
    openFileSessionId?: string;
    /** dealer_onboarding_applications.id that file is driving. */
    openApplicationId?: string;
    /** Page offset for the OP_PICK_DEALER list (10 rows per page). */
    pickPage?: number;
    /** Partially-collected details while opening a new dealer file. */
    draft?: { dealerWaPhone?: string; dealerName?: string };
    /** True while the operator is browsing their OWN dealer console (only
     *  possible when their number is also an approved dealer), so the operator
     *  turn knows to hand the message to runConsoleTurn. */
    inDealerConsole?: boolean;
  };
};

/**
 * Back-link an inbound message to the conversation it turned out to belong to.
 *
 * recordInbound() runs in the webhook BEFORE the session is resolved, so it
 * writes session_id = NULL — which left every inbound message unattributable and
 * made a transcript view impossible (only outbound rows carried a session).
 * Called once the session is known; for an operator turn it is called again with
 * the dealer FILE session, so the message lands on the right dealer's transcript
 * rather than the operator's hub. Best-effort: never fails a turn.
 */
export async function attachInboundToSession(
  providerMessageId: string | null | undefined,
  sessionId: string,
): Promise<void> {
  if (!providerMessageId) return;
  try {
    await db
      .update(whatsappMessages)
      .set({ session_id: sessionId })
      .where(eq(whatsappMessages.provider_message_id, providerMessageId));
  } catch (err) {
    console.error("[WhatsApp/session-store] attachInbound failed:", err);
  }
}

export async function loadSession(id: string): Promise<SessionRow> {
  const [row] = await db
    .select()
    .from(whatsappOnboardingSessions)
    .where(eq(whatsappOnboardingSessions.id, id))
    .limit(1);
  return row;
}

export async function setSession(
  id: string,
  patch: Partial<SessionRow>,
): Promise<void> {
  await db
    .update(whatsappOnboardingSessions)
    .set({ ...patch, updated_at: new Date() } as any)
    .where(eq(whatsappOnboardingSessions.id, id));
}

/** Read-modify-write the session context jsonb. */
export async function mergeContext(
  session: SessionRow,
  mutate: (ctx: Ctx) => void,
): Promise<void> {
  const fresh = await loadSession(session.id);
  const ctx = ((fresh.context ?? {}) as Ctx) || {};
  mutate(ctx);
  await db
    .update(whatsappOnboardingSessions)
    .set({ context: ctx as any, updated_at: new Date() })
    .where(eq(whatsappOnboardingSessions.id, session.id));
}

export async function patchApplication(
  applicationId: string | null,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!applicationId || Object.keys(patch).length === 0) return;
  await db
    .update(dealerOnboardingApplications)
    .set({ ...patch, updated_at: new Date() } as any)
    .where(eq(dealerOnboardingApplications.id, applicationId));
}

export async function reply(
  session: SessionRow,
  body: string,
  buttons?: ReplyButton[],
): Promise<void> {
  const adapter = getAdapter();
  const res = buttons
    ? await adapter.sendInteractive(session.wa_phone, body, buttons)
    : await adapter.sendText(session.wa_phone, body);

  await db.insert(whatsappMessages).values({
    session_id: session.id,
    provider_message_id: res.providerMessageId,
    direction: "outbound",
    message_type: buttons ? "interactive" : "text",
    text_body: body,
    delivery_status: res.ok ? "sent" : "failed",
    raw_payload: (res.raw ?? null) as any,
  });
  await setSession(session.id, { last_outbound_at: new Date() });
}

/** Send an interactive List (for >3 choices, e.g. the dealer console menu). */
export async function replyList(
  session: SessionRow,
  body: string,
  button: string,
  rows: ListRow[],
): Promise<void> {
  const res = await getAdapter().sendList(session.wa_phone, body, button, rows);
  await db.insert(whatsappMessages).values({
    session_id: session.id,
    provider_message_id: res.providerMessageId,
    direction: "outbound",
    message_type: "interactive",
    text_body: body,
    delivery_status: res.ok ? "sent" : "failed",
    raw_payload: (res.raw ?? null) as any,
  });
  await setSession(session.id, { last_outbound_at: new Date() });
}
