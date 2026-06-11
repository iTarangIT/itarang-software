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

import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
  whatsappMessages,
  whatsappOnboardingSessions,
} from "@/lib/db/schema";

import { getAdapter } from "./index";
import {
  ASK_FIELDS,
  COMPANY_TYPE_PROMPT,
  type CompanyType,
  docSpec,
  parseCompanyType,
  requiredDocuments,
} from "./checklist";
import { readDocument } from "./extraction";
import { maskAccount, maskGstin, maskIfsc, maskPan } from "./masking";
import { saveMedia } from "./storage";
import { checkDocument } from "./verification";
import type { InboundEvent, ReplyButton } from "./types";

const MIN_CONFIDENCE = Number(process.env.WHATSAPP_MIN_CONFIDENCE ?? 0.55);
const PLACEHOLDER_COMPANY = "WhatsApp onboarding (pending)";

const CONFIRM_WORDS = /^(confirm|confirmed|ok|okay|yes|yep|y|haan|ha|sahi)$/i;
const CHANGE_WORDS = /^(change|edit|wrong|correct|no|nahi|galat)$/i;

type SessionRow = typeof whatsappOnboardingSessions.$inferSelect;
type Ctx = {
  answers?: Record<string, unknown>;
  docs?: Record<string, { fields: Record<string, unknown>; confidence: number }>;
  fieldIndex?: number;
};

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

  const session = await getOrCreateSession(event);
  await setSession(session.id, { last_inbound_at: new Date() });

  try {
    switch (session.current_state) {
      case "GREETING":
        return await onGreeting(session);
      case "ASK_COMPANY_TYPE":
        return await onCompanyType(session, event);
      case "COLLECTING_DOC":
        return await onDocument(session, event);
      case "ASK_FIELD":
        return await onField(session, event);
      case "AWAIT_CONFIRM":
        return await onConfirm(session, event);
      case "SUBMITTED":
        return void (await reply(
          session,
          "Your application is already submitted and under review. Our team will contact you shortly.",
        ));
      default:
        return await onGreeting(session);
    }
  } catch (err) {
    console.error("[WhatsApp/orchestrator] turn failed:", err);
    await reply(
      session,
      "Sorry, something went wrong on our side. Please try again in a moment.",
    );
  }
}

// ── State handlers ──────────────────────────────────────────────────────────

async function onGreeting(session: SessionRow): Promise<void> {
  await reply(
    session,
    "👋 Welcome to *iTarang* dealer onboarding!\n\nWe'll collect your business documents right here on WhatsApp. It only takes a few minutes.",
  );
  await reply(session, COMPANY_TYPE_PROMPT);
  await setSession(session.id, { current_state: "ASK_COMPANY_TYPE" });
}

async function onCompanyType(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const ct = event.type === "text" ? parseCompanyType(event.text ?? "") : null;
  if (!ct) {
    await reply(
      session,
      "Sorry, I didn't catch that. " + COMPANY_TYPE_PROMPT,
    );
    return;
  }

  await mergeContext(session, (ctx) => {
    ctx.answers = { ...(ctx.answers ?? {}), companyType: ct };
  });
  await patchApplication(session.application_id, { company_type: ct });

  const firstDoc = requiredDocuments(ct)[0];
  await setSession(session.id, {
    current_state: "COLLECTING_DOC",
    detected_company_type: ct,
    expected_document_type: firstDoc.type,
  });

  await reply(
    session,
    `Great — *${humanCompanyType(ct)}*. I'll now ask for your documents one at a time.`,
  );
  await reply(session, firstDoc.request);
}

async function onDocument(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const ct = session.detected_company_type as CompanyType | null;
  const expected = session.expected_document_type!;
  const spec = docSpec(ct, expected);

  // The dealer typed instead of sending a file → re-ask for the document.
  if (!event.mediaProviderId) {
    await reply(
      session,
      `Please send a *photo or PDF*. ${spec?.request ?? ""}`.trim(),
    );
    return;
  }

  // SAVE — download original and persist untouched.
  const adapter = getAdapter();
  const media = await adapter.downloadMedia(event.mediaProviderId);
  const saved = await saveMedia({
    buffer: media.buffer,
    mimeType: media.mimeType,
    applicationId: session.application_id!,
    docType: expected,
    fileName: event.fileName,
  });

  // READ — extract fields with Gemini.
  const extraction = await readDocument(media.buffer, media.mimeType, expected);

  // Unreadable → ask to resend; do NOT advance.
  if (!extraction.ok || !extraction.legible) {
    await insertDocRow(session, expected, saved, media.mimeType, {
      extraction,
      check: null,
      verificationStatus: "rejected",
    });
    await reply(
      session,
      `This *${spec?.label ?? expected}* is not clear enough to read. Please resend a clearer photo or PDF.`,
    );
    return;
  }

  // Wrong document type → ask for the right one; do NOT advance.
  if (!extraction.isExpectedType) {
    await insertDocRow(session, expected, saved, media.mimeType, {
      extraction,
      check: null,
      verificationStatus: "rejected",
    });
    await reply(
      session,
      `This doesn't look like a *${spec?.label ?? expected}*. ${spec?.request ?? ""}`.trim(),
    );
    return;
  }

  // CHECK — Decentro verification for the verifiable doc types.
  const check = await checkDocument(expected, extraction.fields);

  await insertDocRow(session, expected, saved, media.mimeType, {
    extraction,
    check,
    verificationStatus: check.status === "verified" ? "verified" : "pending",
  });

  // FILL — map values onto the application; record warnings (never silent).
  await fillFromDoc(session, expected, extraction.fields);
  if (check.warnings.length) {
    await appendWarnings(session.application_id, check.warnings);
  }

  // Persist into the session context so the summary can show it.
  await mergeContext(session, (ctx) => {
    ctx.docs = {
      ...(ctx.docs ?? {}),
      [expected]: { fields: extraction.fields, confidence: extraction.confidence },
    };
  });

  if (extraction.confidence < MIN_CONFIDENCE) {
    await reply(
      session,
      `Got your *${spec?.label ?? expected}* ✅ (some values were hard to read — our team will double-check).`,
    );
  } else {
    await reply(session, `Got your *${spec?.label ?? expected}* ✅`);
  }

  // Advance to the next document, or move on to the typed questions.
  await advanceDocument(session);
}

async function advanceDocument(session: SessionRow): Promise<void> {
  const ct = session.detected_company_type as CompanyType | null;
  const docs = requiredDocuments(ct);
  const idx = docs.findIndex((d) => d.type === session.expected_document_type);
  const next = docs[idx + 1];

  if (next) {
    await setSession(session.id, { expected_document_type: next.type });
    await reply(session, next.request);
    return;
  }

  // All documents collected → start the typed questions.
  await setSession(session.id, {
    current_state: "ASK_FIELD",
    expected_document_type: null,
  });
  const fresh = await loadSession(session.id);
  await mergeContext(fresh, (ctx) => {
    ctx.fieldIndex = 0;
  });
  await reply(fresh, "Almost done! A few quick questions.");
  await reply(fresh, ASK_FIELDS[0].question);
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

// ── DB helpers ──────────────────────────────────────────────────────────────

async function getOrCreateSession(event: InboundEvent): Promise<SessionRow> {
  const existing = await db
    .select()
    .from(whatsappOnboardingSessions)
    .where(eq(whatsappOnboardingSessions.wa_phone, event.waPhone))
    .orderBy(desc(whatsappOnboardingSessions.created_at))
    .limit(1);
  if (existing.length > 0) return existing[0];

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

  return session;
}

async function loadSession(id: string): Promise<SessionRow> {
  const [row] = await db
    .select()
    .from(whatsappOnboardingSessions)
    .where(eq(whatsappOnboardingSessions.id, id))
    .limit(1);
  return row;
}

async function setSession(
  id: string,
  patch: Partial<SessionRow>,
): Promise<void> {
  await db
    .update(whatsappOnboardingSessions)
    .set({ ...patch, updated_at: new Date() } as any)
    .where(eq(whatsappOnboardingSessions.id, id));
}

/** Read-modify-write the session context jsonb. */
async function mergeContext(
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

async function patchApplication(
  applicationId: string | null,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!applicationId || Object.keys(patch).length === 0) return;
  await db
    .update(dealerOnboardingApplications)
    .set({ ...patch, updated_at: new Date() } as any)
    .where(eq(dealerOnboardingApplications.id, applicationId));
}

async function appendWarnings(
  applicationId: string | null,
  warnings: string[],
): Promise<void> {
  if (!applicationId || warnings.length === 0) return;
  const [row] = await db
    .select({ w: dealerOnboardingApplications.verification_warnings })
    .from(dealerOnboardingApplications)
    .where(eq(dealerOnboardingApplications.id, applicationId))
    .limit(1);
  const existing = Array.isArray(row?.w) ? (row!.w as unknown[]) : [];
  await db
    .update(dealerOnboardingApplications)
    .set({
      verification_warnings: [...existing, ...warnings],
      updated_at: new Date(),
    } as any)
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
  const patch: Record<string, unknown> = {};
  switch (docType) {
    case "gst":
      if (str(fields.gstin)) patch.gst_number = str(fields.gstin);
      // Replace the placeholder company name with the real legal/trade name.
      if (str(fields.legal_name) || str(fields.trade_name)) {
        patch.company_name = str(fields.legal_name) || str(fields.trade_name);
      }
      break;
    case "company_pan":
      if (str(fields.pan)) patch.pan_number = str(fields.pan);
      break;
    case "bank_statement":
    case "cancelled_cheque":
      if (str(fields.bank_name)) patch.bank_name = str(fields.bank_name);
      if (str(fields.account_number)) patch.account_number = str(fields.account_number);
      if (str(fields.ifsc)) patch.ifsc_code = str(fields.ifsc);
      if (str(fields.account_holder_name)) patch.beneficiary_name = str(fields.account_holder_name);
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

async function reply(
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
      if (/^(yes|y|haan|ha)$/i.test(v)) return true;
      if (/^(no|n|nahi)$/i.test(v)) return false;
      return null;
    default:
      return null;
  }
}

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
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
