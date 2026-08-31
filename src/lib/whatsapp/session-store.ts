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

import { and, eq, sql } from "drizzle-orm";

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
  /** Customer journeys the dealer walked away from mid-way (sent *menu* or
   *  started another lead) that are NOT pre-submit drafts — co-borrower, Step 4,
   *  offers, dispatch. The DB cannot reconstruct those steps, so the exact
   *  `lead` sub-context and state are snapshotted here, keyed by lead id, and
   *  restored verbatim when the dealer picks the lead from Save Drafts. */
  parked?: Record<
    string,
    { state: string; lead: NonNullable<Ctx["lead"]>; at: string }
  >;
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

    // ---- E-264: the rest of the journey. One sub-object per phase, so a
    // phase can be reset (or abandoned) without disturbing the others, and so
    // patchLeadSub() can write one of them atomically. ----

    /** Co-borrower capture (DC_CB_*). */
    cb?: {
      requestId?: string;
      coBorrowerId?: string;
      /** Cursor into CO_BORROWER_QUESTIONS. */
      qIndex?: number;
      /** Co-borrower's own name from their first ID doc. Checked BOTH ways:
       *  against their other documents, and against the primary borrower's —
       *  a "co-borrower" who is the same person is the thing this prevents. */
      name?: string;
      docs?: Record<string, true>;
      consentOtpAttempts?: number;
      consentOtpChannel?: "call" | "sms" | "whatsapp";
      /** They took the web link instead; poll for completion on next inbound. */
      webLinked?: true;
    };

    /** Step 4 — routing the lead to lenders (DC_S4_*). */
    s4?: {
      loanAmount?: number;
      /** The BRE-matched lenders offered, so a tapped row resolves back. */
      options?: Array<{
        nbfcId: number;
        loanProductId: number | null;
        label: string;
        sub: string;
      }>;
      /** Paging cursor for the lender list — mirrors ctx.op.pickPage. */
      page?: number;
      /** Capped at 2, matching submitProductSelectionSchema. */
      picked?: Array<{ nbfc_id: string; loan_product_id: string | null }>;
      preSanctionDocs?: Array<{
        url: string;
        name: string;
        type: string;
        size: number;
      }>;
    };

    /** Step-4 extra documents (DC_XD_*) — the ≤10 pre-sanction bucket. The
     *  files themselves live on product_selections.pre_sanction_doc_urls; this
     *  only carries what the chat needs between two inbound messages. */
    xd?: {
      /** Items in the bucket after the last save, for the "n/10" counter. */
      count?: number;
      /** Set when an NBFC request opened this step: its nbfc_doc_requests.id,
       *  so each file also answers the request's next open child. */
      requestId?: string;
      /** Where to go when the batch ends — the new-lead ladder continues to
       *  consent / submit; a request-driven batch returns to the menu. */
      next?: "consent" | "submit" | "menu";
      /** Files saved in THIS batch, for the single end-of-batch notification. */
      batch?: number;
    };

    /** Offers and sanction (DC_OF_*, DC_SN_*). */
    of?: {
      offers?: Array<{
        nbfcId: number;
        name: string;
        emi: string;
        tenure: number;
        roi: string;
        loanAmount: string;
      }>;
      pickedNbfcId?: number;
    };
    sn?: { sanctionId?: string; nbfcName?: string };

    /** Step 5 — dispatch (DC_DP_*). */
    dp?: {
      selectionId?: string;
      otpAttempts?: number;
      otpChannel?: "call" | "sms" | "whatsapp";
      /** Read back from product_selections for display only — never typed in
       *  chat. A mistyped serial fails mid-transaction after stock has moved. */
      batterySerial?: string;
      /** Paging cursor for the stock lists. */
      page?: number;
      /** The charger chosen alongside `batterySerial`, or null for "no charger".
       *  Held here rather than passed down the call chain because the dealer's
       *  margin steps sit between the pick and the save, and every one of them
       *  is a separate inbound message. */
      chargerSerial?: string | null;
      /** Dealer margin (DC_DP_MARGIN / DC_DP_MARGIN_VAL). `mode` + `value` are
       *  what the dealer typed; `amount` is the resolved rupee figure, kept so
       *  the preview the dealer approved and the row we write cannot drift. */
      marginMode?: "percent" | "rupees";
      marginValue?: number;
      marginAmount?: number;
      /** 18% GST on marginAmount (E-273). */
      marginGst?: number;
      /** The order card has been sent to the customer (DC_DP_OTP onwards). Set
       *  so a re-tap of Send does not message them twice. */
      orderSentAt?: string;
      /** The picker is running as the front half of STEP 4 (pre-lender):
       *  confirming derives requested_loan_amount instead of saving. */
      phase?: "step4" | null;
      /** Loan sanctioned against the stored selection — Send-only, no edits. */
      locked?: boolean | null;
      /** Stock-forced exception to the lock: the approved serial vanished, a
       *  replacement battery may be picked; the margin stays as approved. */
      repickAllowed?: boolean | null;
    };
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
  /** "Active batteries" browser (DC_ACTIVE_BATT) — paging cursor only. */
  ab?: { page?: number };
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

/**
 * E-264 — atomically merge a patch into `context.lead`, in SQL.
 *
 * mergeContext above is a read-modify-write with nothing holding the row in
 * between, which was harmless while only an inbound turn ever wrote: turns for
 * one phone are serialised by the customer's own typing speed. It stops being
 * harmless once the journey pushes into a chat out of band — a "your loan is
 * sanctioned" push landing while the customer is mid-reply will silently drop
 * one of the two writes.
 *
 * Rather than touch mergeContext's ~40 existing call sites, new journey code
 * writes through this. `||` is a shallow jsonb merge, so keys the caller did not
 * mention are preserved even if another writer added them a millisecond ago.
 */
export async function patchLead(
  sessionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await db
    .update(whatsappOnboardingSessions)
    .set({
      context: sql`jsonb_set(
        coalesce(${whatsappOnboardingSessions.context}, '{}'::jsonb),
        '{lead}',
        coalesce(${whatsappOnboardingSessions.context} -> 'lead', '{}'::jsonb)
          || ${JSON.stringify(patch)}::jsonb,
        true)`,
      updated_at: new Date(),
    })
    .where(eq(whatsappOnboardingSessions.id, sessionId));
}

/** Same, one level deeper: context.lead.<key> — e.g. the per-phase sub-objects. */
export async function patchLeadSub(
  sessionId: string,
  key: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await db
    .update(whatsappOnboardingSessions)
    .set({
      context: sql`jsonb_set(
        coalesce(${whatsappOnboardingSessions.context}, '{}'::jsonb),
        ${sql.raw(`'{lead,${key.replace(/[^a-zA-Z0-9_]/g, "")}}'`)},
        coalesce(
          ${whatsappOnboardingSessions.context} -> 'lead' -> ${key},
          '{}'::jsonb
        ) || ${JSON.stringify(patch)}::jsonb,
        true)`,
      updated_at: new Date(),
    })
    .where(eq(whatsappOnboardingSessions.id, sessionId));
}

/**
 * E-264 — compare-and-swap on the conversation state. Returns false when the
 * session had already moved on, meaning someone else got there first.
 *
 * Used to guard the steps that spend money or move stock — winner selection and
 * dispatch confirmation — against a double-tap. WhatsApp buttons stay tappable
 * after they are pressed, and a customer on a bad connection will press twice.
 * This is belt; the braces are the provider_message_id dedupe in the webhook and
 * the existing DB guards (assignment status, otp_confirmations.is_used).
 */
export async function setSessionIf(
  id: string,
  expectState: string,
  patch: Partial<SessionRow>,
): Promise<boolean> {
  const rows = await db
    .update(whatsappOnboardingSessions)
    .set({ ...patch, updated_at: new Date() } as any)
    .where(
      and(
        eq(whatsappOnboardingSessions.id, id),
        eq(whatsappOnboardingSessions.current_state, expectState),
      ),
    )
    .returning({ id: whatsappOnboardingSessions.id });
  return rows.length === 1;
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
