/**
 * E-264 Phase 1 — supplying a co-borrower over WhatsApp.
 *
 * THE GAP THIS CLOSES.
 *
 * A co-borrower is never volunteered: an admin (or an NBFC, via the admin
 * one-click) requests one, and requestCoBorrowerForLead() flips the lead to
 * awaiting_co_borrower_kyc. From that moment the admin's KYC screen shows
 * "Co-borrower KYC requested — awaiting dealer submission" and stays there until
 * somebody opens the dealer portal and completes Step 3. For a lead that arrived
 * over WhatsApp and has never seen the portal, that is a dead end.
 *
 * TWO THINGS HERE ARE EASY TO GET WRONG AND EXPENSIVE.
 *
 * 1. Documents go to `kyc_documents` with doc_for='borrower', NOT to
 *    `co_borrower_documents`. The latter is written only by an older, unused
 *    route; the admin verification cards read the former. Writing only the
 *    legacy table produces a co-borrower that looks complete in chat and is
 *    invisible to the admin. We write both, but kyc_documents is the one that
 *    counts.
 *
 * 2. We must NOT call fillCustomerLeadFromDoc(). That helper writes the PRIMARY
 *    borrower's `leads` and `personal_details` rows, so running it on a
 *    co-borrower's Aadhaar silently overwrites the customer's own name, PAN, DOB
 *    and address with someone else's. The extracted fields go to `co_borrowers`
 *    and nowhere else.
 */

import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import {
  coBorrowerDocuments,
  coBorrowers,
  documents as leadDocuments,
  kycDocuments,
  leads,
  personalDetails,
  whatsappMessages,
} from "@/lib/db/schema";
import { submitCoBorrowerVerification } from "@/lib/kyc/coborrower-submit";
import {
  generateManualConsentPdf,
  sendConsentOtp,
  storeSignedConsent,
  verifyConsentOtp,
} from "@/lib/kyc/consent-service";

import type { ActiveDealer } from "./customer-lead";
import { classifyDocument } from "./extraction";
import { getAdapter } from "./index";
import { leadActionId } from "./leadActionButton";
import { registerLeadAction } from "./leadActionReply";
import { pushToLead } from "./lead-push";
import { registerLeadState } from "./lead-states";
import {
  patchLeadSub,
  reply,
  replyList,
  setSession,
  type SessionRow,
} from "./session-store";
import { saveMedia } from "./storage";
import type { InboundEvent, ListRow, ReplyButton } from "./types";
import { oneLine } from "./window";

export const DC_CB_FIELD = "DC_CB_FIELD";
export const DC_CB_DOCS = "DC_CB_DOCS";
export const DC_CB_CONSENT = "DC_CB_CONSENT";
export const DC_CB_CONSENT_OTP = "DC_CB_CONSENT_OTP";
export const DC_CB_CONSENT_MANUAL = "DC_CB_CONSENT_MANUAL";
export const DC_CB_REVIEW = "DC_CB_REVIEW";
export const DC_CB_WAIT = "DC_CB_WAIT";

/** Minimum confidence before we accept Gemini's read of a document. */
const MIN_CONFIDENCE = Number(process.env.WHATSAPP_MIN_CONFIDENCE ?? 0.55);

/** Mirrors CO_BORROWER_DOCS in lead-wizard/constants.ts (the required four). */
const REQUIRED_DOCS = [
  "aadhaar_front",
  "aadhaar_back",
  "pan_card",
  "passport_photo",
] as const;

const DOC_LABEL: Record<string, string> = {
  aadhaar_front: "Aadhaar (front)",
  aadhaar_back: "Aadhaar (back)",
  pan_card: "PAN card",
  passport_photo: "Passport-size photo",
};

// ---------------------------------------------------------------------------
// Question battery
// ---------------------------------------------------------------------------

interface CbQuestion {
  /** Column on co_borrowers. */
  key: string;
  body: string;
  buttons?: ReplyButton[];
  rows?: ListRow[];
  /** Return null to reject the answer and re-ask with `error`. */
  parse: (e: InboundEvent, ctx: CbAnswers) => unknown | null;
  error: string;
  skipIf?: (a: CbAnswers) => boolean;
}

type CbAnswers = Record<string, unknown> & { primaryPhone?: string | null };

const RELATIONSHIP_ROWS: ListRow[] = [
  { id: "rel_spouse", title: "Spouse", description: "Husband or wife" },
  { id: "rel_father", title: "Father", description: "" },
  { id: "rel_mother", title: "Mother", description: "" },
  { id: "rel_son", title: "Son", description: "" },
  { id: "rel_daughter", title: "Daughter", description: "" },
  { id: "rel_brother", title: "Brother", description: "" },
  { id: "rel_sister", title: "Sister", description: "" },
  { id: "rel_other", title: "Other", description: "Any other relation" },
];

function text(e: InboundEvent): string {
  return (e.text ?? "").trim();
}

/** 10 digits, stored as +91XXXXXXXXXX to match the primary borrower's format. */
function parsePhone(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length !== 10) return null;
  return `+91${d}`;
}

/**
 * Only TWO questions are asked.
 *
 * Everything else — name, father's/husband's name, date of birth, address,
 * Aadhaar and PAN — is read off the documents by applyExtractedFields(). Asking
 * someone to retype what is printed on the Aadhaar they are about to photograph
 * is nine chances to introduce a typo into a field an underwriter will compare
 * against that very document.
 *
 * These two survive because neither is on any document:
 *   • relationship — a fact about the pair, not about the person
 *   • phone        — the co-borrower's OWN number, which the consent OTP is
 *                    sent to, so it must be theirs and not the applicant's
 */
const CO_BORROWER_QUESTIONS: CbQuestion[] = [
  {
    key: "relationship",
    body: "👥 *Co-borrower details* (1/2)\n\nWho is the co-borrower to the customer?",
    rows: RELATIONSHIP_ROWS,
    parse: (e) => {
      const t = text(e).toLowerCase();
      const hit = RELATIONSHIP_ROWS.find(
        (r) => r.id === t || r.title.toLowerCase() === t,
      );
      return hit ? hit.title.toLowerCase() : null;
    },
    error: "Please tap one of the options above.",
  },
  {
    key: "phone",
    body:
      "(2/2) The co-borrower's *own 10-digit mobile number*?\n\n" +
      "_We'll send the consent code to this number, so it must be theirs — not the customer's._",
    parse: (e, a) => {
      const p = parsePhone(text(e));
      if (!p) return null;
      // A co-borrower sharing the applicant's number is almost always the
      // applicant entered twice — and it would send their consent OTP to the
      // very person whose loan they are guaranteeing.
      if (a.primaryPhone && p === a.primaryPhone) return null;
      return p;
    },
    error:
      "That doesn't look right. Send 10 digits, and it must be *different* from the customer's own number.",
  },
];

// ---------------------------------------------------------------------------
// Entry: the admin/NBFC request lands in the chat
// ---------------------------------------------------------------------------

/**
 * Announce a co-borrower request. Best-effort — hung off the side of
 * requestCoBorrowerForLead(), which has already committed.
 */
export async function pushCoBorrowerRequest(
  leadId: string,
  reason?: string | null,
): Promise<void> {
  const why = reason?.trim();

  // The work is identical whoever does it; only the subject of the sentence
  // changes. A dealer running the file is told WHOSE application this is — they
  // are holding several — and that the relative belongs to the customer, not to
  // them.
  await pushToLead(leadId, (t) => {
    const dealerSide = t.audience === "dealer";
    const whose = dealerSide
      ? `your customer *${t.customerName}*'s application ${t.referenceId}`
      : `application ${t.referenceId}`;
    const relative = dealerSide
      ? "a family member of the customer"
      : "a family member";

    return {
      prompt: {
        kind: "text",
        body:
          `👥 *A co-borrower is needed*\n\n` +
          `Hi ${t.greetName}, to move ${whose} forward, the lender needs a ` +
          `co-borrower — ${relative} who will share responsibility for the loan.` +
          (why ? `\n\n_Reason: ${why}_` : "") +
          `\n\nIt takes about 3 minutes: a few details, then photos of their ` +
          `Aadhaar, PAN and a passport photo.`,
        buttons: [
          { id: leadActionId("cb_start", leadId), title: "➕ Add now" },
          { id: leadActionId("cb_later", leadId), title: "⏰ Later" },
        ],
      },
      nudge: {
        template: "lead_action",
        params: [
          oneLine(t.greetName),
          oneLine(t.referenceId),
          dealerSide
            ? `a co-borrower is required for ${t.customerName}`
            : "a co-borrower is required",
        ],
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function ensureCoBorrowerRow(leadId: string): Promise<string> {
  const [existing] = await db
    .select({ id: coBorrowers.id })
    .from(coBorrowers)
    .where(eq(coBorrowers.lead_id, leadId))
    .limit(1);
  if (existing) return existing.id;

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");
  const id = `COBOR-${dateStr}-${seq}`;
  await db
    .insert(coBorrowers)
    .values({ id, lead_id: leadId, created_at: now, updated_at: now });
  return id;
}

/** `cb_start:<leadId>` */
async function onCoBorrowerStart(
  session: SessionRow,
  _event: InboundEvent,
  _dealer: ActiveDealer,
  leadId: string,
): Promise<void> {
  const [lead] = await db
    .select({
      has_co_borrower: leads.has_co_borrower,
      mobile: leads.mobile,
      phone: leads.phone,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  if (!lead?.has_co_borrower) {
    await reply(
      session,
      "There's no co-borrower pending on this application right now.",
    );
    return;
  }

  const coBorrowerId = await ensureCoBorrowerRow(leadId);
  await patchLeadSub(session.id, "cb", {
    coBorrowerId,
    qIndex: 0,
    docs: {},
    primaryPhone: lead.mobile ?? lead.phone ?? null,
  });
  await setSession(session.id, { current_state: DC_CB_FIELD });
  await askQuestion(session, 0);
}

/** `cb_later:<leadId>` */
async function onCoBorrowerLater(session: SessionRow): Promise<void> {
  await reply(
    session,
    "No problem. Send *hi* whenever you're ready and I'll pick this up again — " +
      "the application stays on hold until the co-borrower is added.",
  );
}

async function askQuestion(session: SessionRow, index: number): Promise<void> {
  const q = CO_BORROWER_QUESTIONS[index];
  if (q.rows) {
    await replyList(session, q.body, "Choose", q.rows);
  } else {
    await reply(session, q.body, q.buttons);
  }
}

/** The `ctx.lead.cb` sub-object, as this flow reads and writes it. */
interface CbState {
  coBorrowerId?: string;
  qIndex?: number;
  docs?: Record<string, true>;
  primaryPhone?: string | null;
  /** Established by the first name-bearing document; later ones must match. */
  name?: string;
  consentOtpAttempts?: number;
  consentOtpChannel?: "call" | "sms" | "whatsapp";
}

function cbCtx(session: SessionRow): { leadId?: string; cb?: CbState } {
  const ctx = (session.context ?? {}) as {
    lead?: { leadId?: string; cb?: CbState };
  };
  return { leadId: ctx.lead?.leadId, cb: ctx.lead?.cb };
}

/** DC_CB_FIELD — one answer per turn, persisted straight to co_borrowers. */
async function onCoBorrowerField(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const { leadId, cb } = cbCtx(session);
  if (!leadId || !cb) return await lostTrack(session);

  const index = cb.qIndex ?? 0;
  const q = CO_BORROWER_QUESTIONS[index];
  if (!q) return await startDocs(session);

  const answers: CbAnswers = { primaryPhone: cb.primaryPhone ?? null };
  // is_current_same is the only prior answer a later question depends on, and
  // it is already on the row — read it back rather than carrying a shadow copy.
  const [row] = await db
    .select({ is_current_same: coBorrowers.is_current_same })
    .from(coBorrowers)
    .where(eq(coBorrowers.lead_id, leadId))
    .limit(1);
  answers.is_current_same = row?.is_current_same ?? false;

  const value = q.parse(event, answers);
  if (value === null || value === undefined) {
    await reply(session, q.error, q.buttons);
    return;
  }

  await db
    .update(coBorrowers)
    .set({ [q.key]: value as never, updated_at: new Date() })
    .where(eq(coBorrowers.lead_id, leadId));

  // Advance, honouring skipIf against the answer we just stored.
  const merged: CbAnswers = { ...answers, [q.key]: value };
  let next = index + 1;
  while (next < CO_BORROWER_QUESTIONS.length && CO_BORROWER_QUESTIONS[next].skipIf?.(merged)) {
    next += 1;
  }

  if (next >= CO_BORROWER_QUESTIONS.length) {
    return await startDocs(session);
  }

  await patchLeadSub(session.id, "cb", { qIndex: next });
  await askQuestion(session, next);
}

async function startDocs(session: SessionRow): Promise<void> {
  await setSession(session.id, { current_state: DC_CB_DOCS });
  await reply(
    session,
    "📎 *Co-borrower documents*\n\nNow please send these, one at a time:\n\n" +
      REQUIRED_DOCS.map((d) => `• ${DOC_LABEL[d]}`).join("\n") +
      "\n\nA clear photo of each is fine.",
  );
}

/**
 * Map Gemini's detected type onto our doc keys. Deliberately narrow: anything
 * we do not recognise is rejected and re-asked rather than filed under a guess.
 */
function normalizeCbDocType(detected: string): string | null {
  const t = (detected || "").toLowerCase();
  if (t.includes("aadhaar") && t.includes("back")) return "aadhaar_back";
  if (t.includes("aadhaar")) return "aadhaar_front";
  if (t.includes("pan")) return "pan_card";
  if (t.includes("photo") || t.includes("passport")) return "passport_photo";
  if (t.includes("cheque")) return "cheque_1";
  if (t.includes("bank")) return "bank_statement";
  if (t.includes("address")) return "address_proof";
  return null;
}

/** DC_CB_DOCS — ingest one file per turn. */
async function onCoBorrowerDocs(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const { leadId, cb } = cbCtx(session);
  if (!leadId || !cb?.coBorrowerId) return await lostTrack(session);

  if (event.type !== "image" && event.type !== "document") {
    await reply(
      session,
      "Please send the document as a *photo* or a *PDF*.\n\nStill needed: " +
        pending(cb.docs).map((d) => DOC_LABEL[d]).join(", "),
    );
    return;
  }
  if (!event.mediaProviderId) {
    await reply(session, "That file didn't come through — please send it again.");
    return;
  }

  let buffer: Buffer;
  let mimeType: string;
  let fileName: string | undefined;
  try {
    const media = await getAdapter().downloadMedia(event.mediaProviderId);
    buffer = media.buffer;
    mimeType = media.mimeType || event.mimeType || "application/octet-stream";
    fileName = media.fileName ?? event.fileName;
  } catch (err) {
    console.error("[WhatsApp/coborrower] media download failed:", err);
    await reply(session, "I couldn't download that file — please send it again.");
    return;
  }

  // A ZIP is the natural way to send four documents at once, and the primary
  // KYC flow already accepts one. Without this branch the archive is handed to
  // Gemini as raw bytes and comes back "I couldn't read that clearly", which
  // blames the customer for something the bot never tried to open.
  if (isZip(mimeType, fileName)) {
    return await ingestCoBorrowerZip(session, leadId, cb, buffer);
  }

  const classified = await classifyDocument(buffer, mimeType);
  if (!classified.ok || !classified.legible) {
    await reply(
      session,
      "I couldn't read that clearly. Please retake it in good light, with all four corners visible.",
    );
    return;
  }
  const docType = normalizeCbDocType(classified.documentType);
  if (!docType || classified.confidence < MIN_CONFIDENCE) {
    await reply(
      session,
      "I couldn't tell which document that is. Please send one of: " +
        pending(cb.docs).map((d) => DOC_LABEL[d]).join(", "),
    );
    return;
  }

  // Exact-number check first — it is the one that cannot be argued with.
  const clash = await documentBelongsToPrimary(leadId, classified.fields);
  if (clash) {
    await reply(
      session,
      `⚠️ That ${clash} belongs to the *customer*, not a co-borrower.\n\n` +
        "The co-borrower must be a different person with their own documents.",
    );
    return;
  }

  // Cross-role identity check. A "co-borrower" who is the same person as the
  // applicant is the exact thing requesting a co-borrower exists to prevent, and
  // it is trivially easy to do by photographing the wrong Aadhaar.
  const extractedName = pickName(classified.fields);
  if (extractedName) {
    const [lead] = await db
      .select({ full_name: leads.full_name })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (lead?.full_name && namesMatch(lead.full_name, extractedName)) {
      await reply(
        session,
        `⚠️ That document is in the customer's own name (*${extractedName}*).\n\n` +
          "The co-borrower must be a *different person*. Please send the co-borrower's document.",
      );
      return;
    }
    if (cb.name && !namesMatch(cb.name, extractedName)) {
      await reply(
        session,
        `⚠️ This document is for *${extractedName}*, but the previous one was for *${cb.name}*.\n\n` +
          "All co-borrower documents must belong to the same person.",
      );
      return;
    }
  }

  const saved = await saveMedia({
    buffer,
    mimeType,
    keyPrefix: `leads/${leadId}/whatsapp/coborrower`,
    docType,
    fileName,
  });

  await persistCoBorrowerDoc({
    leadId,
    coBorrowerId: cb.coBorrowerId,
    docType,
    saved,
    fields: classified.fields,
  });

  // Extracted identity numbers belong on co_borrowers — and ONLY there.
  await applyExtractedFields(leadId, docType, classified.fields);

  const docs = { ...(cb.docs ?? {}), [docType]: true as const };
  await patchLeadSub(session.id, "cb", {
    docs,
    ...(extractedName && !cb.name ? { name: extractedName } : {}),
  });

  const left = pending(docs);
  const done = REQUIRED_DOCS.length - left.length;
  if (left.length > 0) {
    await reply(
      session,
      `Got *${DOC_LABEL[docType]}* ✅ (${done}/${REQUIRED_DOCS.length})\n\nNext: *${DOC_LABEL[left[0]]}*`,
    );
    return;
  }

  await startConsent(session, leadId);
}

// ---------------------------------------------------------------------------
// Consent — the co-borrower's own, not the customer's
// ---------------------------------------------------------------------------

/**
 * A co-borrower is agreeing to be liable for someone else's loan, so their
 * consent has to come from THEM. sendConsentOtp with consentFor:"borrower"
 * resolves the signer to the co-borrower row and sends the code to the number
 * captured in question 2 — which is why that question refuses the applicant's
 * own number. The person in the chat cannot consent on their behalf.
 */
async function startConsent(session: SessionRow, leadId: string): Promise<void> {
  const [cb] = await db
    .select({ full_name: coBorrowers.full_name, phone: coBorrowers.phone })
    .from(coBorrowers)
    .where(eq(coBorrowers.lead_id, leadId))
    .limit(1);

  await setSession(session.id, { current_state: DC_CB_CONSENT });
  await reply(
    session,
    `✅ *All documents received.*\n\n` +
      `Last step: *${cb?.full_name ?? "the co-borrower"}* needs to give consent ` +
      `on their own number (${maskPhone(cb?.phone ?? null)}).\n\n` +
      `How should we send the code?`,
    CONSENT_CHANNEL_BUTTONS,
  );
}

/**
 * Three ways to consent, mirroring the primary borrower's flow.
 *
 * Manual exists because the OTP paths assume the co-borrower can be reached on
 * their own phone right now. Often they are sitting in the same shop as the
 * customer, or their number is on a handset they do not have with them — and
 * without a printed route those cases simply stall.
 */
const CONSENT_CHANNEL_BUTTONS: ReplyButton[] = [
  { id: "cb_consent_call", title: "📞 Voice call" },
  { id: "cb_consent_sms", title: "💬 SMS" },
  { id: "cb_consent_manual", title: "✍ Print & sign" },
];

function maskPhone(p: string | null): string {
  if (!p) return "their number";
  const d = p.replace(/\D/g, "");
  return d.length >= 4 ? `••••••${d.slice(-4)}` : "their number";
}

/** DC_CB_CONSENT — pick a channel and fire the OTP. */
async function onCoBorrowerConsent(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const { leadId } = cbCtx(session);
  if (!leadId) return await lostTrack(session);

  const t = text(event).toLowerCase();

  if (t === "cb_consent_manual" || t === "manual") {
    return await startManualConsent(session, leadId);
  }

  const channel =
    t === "cb_consent_sms" || t === "sms"
      ? "sms"
      : t === "cb_consent_call" || t === "call"
        ? "call"
        : null;
  if (!channel) {
    await reply(session, "Please choose how to send the consent code.", CONSENT_CHANNEL_BUTTONS);
    return;
  }

  const res = await sendConsentOtp({
    leadId,
    channel,
    consentFor: "borrower",
  });
  if (!res.ok) {
    await reply(
      session,
      `I couldn't send the consent code${res.error ? ` — ${res.error}` : ""}. Please try again.`,
      CONSENT_CHANNEL_BUTTONS,
    );
    return;
  }

  await patchLeadSub(session.id, "cb", { consentOtpAttempts: 0, consentOtpChannel: channel });
  await setSession(session.id, { current_state: DC_CB_CONSENT_OTP });
  await reply(
    session,
    `🔐 A 6-digit consent code has been sent to the co-borrower` +
      (channel === "call" ? " by voice call" : " by SMS") +
      `.\n\nPlease type the 6 digits here.`,
  );
}

/**
 * Manual route — send the consent PDF, take back a signed scan.
 *
 * The PDF is pushed as uploaded BYTES, not as a link. Our storage URLs are
 * auth-gated behind the files proxy, so Meta cannot fetch one to attach; the
 * primary consent flow hit this and settled on bytes for the same reason.
 */
async function startManualConsent(
  session: SessionRow,
  leadId: string,
): Promise<void> {
  const res = await generateManualConsentPdf({
    leadId,
    consentFor: "borrower",
    dealerName: "iTarang",
  });
  if (!res.ok) {
    await reply(
      session,
      `I couldn't prepare the consent form${res.error ? ` — ${res.error}` : ""}. Please pick another option.`,
      CONSENT_CHANNEL_BUTTONS,
    );
    return;
  }

  await setSession(session.id, { current_state: DC_CB_CONSENT_MANUAL });
  await replyDocumentBytes(
    session,
    res.pdfBuffer,
    "application/pdf",
    res.fileName,
    "📄 Co-borrower consent form",
  );
  await reply(
    session,
    "✍ Print this, have the *co-borrower* sign it, then send the signed copy " +
      "back here as a *PDF or a clear photo*.\n\n" +
      "Prefer a code instead? Type *otp*.",
  );
}

/** DC_CB_CONSENT_MANUAL — waiting for the signed form to come back. */
async function onCoBorrowerConsentManual(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const { leadId } = cbCtx(session);
  if (!leadId) return await lostTrack(session);

  if (event.type !== "document" && event.type !== "image") {
    const t = text(event).toLowerCase();
    if (t === "otp" || t === "code") {
      await setSession(session.id, { current_state: DC_CB_CONSENT });
      await reply(session, "No problem — how should we send the code?", CONSENT_CHANNEL_BUTTONS);
      return;
    }
    await reply(
      session,
      "Please send the *signed* consent form back as a PDF or a clear photo. Type *otp* to use a code instead.",
    );
    return;
  }
  if (!event.mediaProviderId) {
    await reply(session, "That file didn't come through — please send it again.");
    return;
  }

  let buffer: Buffer;
  try {
    const media = await getAdapter().downloadMedia(event.mediaProviderId);
    buffer = media.buffer;
  } catch (err) {
    console.error("[WhatsApp/coborrower] signed consent download failed:", err);
    await reply(session, "I couldn't download that — please send it once more.");
    return;
  }

  const stored = await storeSignedConsent({
    leadId,
    buffer,
    consentFor: "borrower",
  });
  if (!stored.ok) {
    await reply(
      session,
      `I couldn't save that${stored.error ? ` — ${stored.error}` : ""}. Please send it again.`,
    );
    return;
  }

  await reply(session, "✅ *Signed consent received.*");
  await showReview(session, leadId);
}

/** Wrong-code attempts before we make them request a fresh one. */
const MAX_OTP_ATTEMPTS = 5;

/** DC_CB_CONSENT_OTP — verify, then submit. */
async function onCoBorrowerConsentOtp(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const { leadId, cb } = cbCtx(session);
  if (!leadId) return await lostTrack(session);

  const digits = text(event).replace(/\D/g, "");
  if (digits.length !== 6) {
    await reply(session, "Please type the *6-digit* code the co-borrower received.");
    return;
  }

  const res = await verifyConsentOtp({ leadId, otp: digits, consentFor: "borrower" });
  if (!res.ok) {
    const attempts = (cb?.consentOtpAttempts ?? 0) + 1;
    await patchLeadSub(session.id, "cb", { consentOtpAttempts: attempts });
    if (attempts >= MAX_OTP_ATTEMPTS) {
      await setSession(session.id, { current_state: DC_CB_CONSENT });
      await reply(
        session,
        "That's too many incorrect attempts. Let's send a fresh code.",
        CONSENT_CHANNEL_BUTTONS,
      );
      return;
    }
    await reply(
      session,
      `That code didn't match. Please check and try again (${MAX_OTP_ATTEMPTS - attempts} attempts left).`,
    );
    return;
  }

  await showReview(session, leadId);
}

function pending(docs?: Record<string, true>): string[] {
  return REQUIRED_DOCS.filter((d) => !docs?.[d]);
}

function isZip(mimeType: string, fileName?: string): boolean {
  return (
    mimeType.includes("zip") ||
    mimeType === "application/x-zip-compressed" ||
    (fileName ?? "").toLowerCase().endsWith(".zip")
  );
}

/** Same cap the primary flow uses — a bigger archive is a mistake, not a batch. */
const MAX_ZIP_ENTRIES = 25;

/**
 * Open an archive and classify every file in it, then report once.
 *
 * Deliberately one consolidated reply rather than a message per file: four
 * separate "Got X ✅" messages for a single upload reads as a malfunction.
 */
async function ingestCoBorrowerZip(
  session: SessionRow,
  leadId: string,
  cb: CbState,
  buffer: Buffer,
): Promise<void> {
  const JSZip = (await import("jszip")).default;
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    await reply(
      session,
      "I couldn't open that ZIP. Please send the documents as individual photos instead.",
    );
    return;
  }

  const entries = Object.values(zip.files)
    .filter((f) => !f.dir && !f.name.startsWith("__MACOSX"))
    .slice(0, MAX_ZIP_ENTRIES);
  if (entries.length === 0) {
    await reply(session, "That ZIP was empty. Please send the documents again.");
    return;
  }

  const docs: Record<string, true> = { ...(cb.docs ?? {}) };
  const accepted: string[] = [];
  const rejected: string[] = [];
  let name = cb.name;

  for (const entry of entries) {
    const bytes = Buffer.from(await entry.async("arraybuffer"));
    const mime = guessMime(entry.name);
    const classified = await classifyDocument(bytes, mime);
    if (!classified.ok || !classified.legible) {
      rejected.push(`${entry.name} — unreadable`);
      continue;
    }
    const docType = normalizeCbDocType(classified.documentType);
    if (!docType || classified.confidence < MIN_CONFIDENCE) {
      rejected.push(`${entry.name} — couldn't tell what it is`);
      continue;
    }

    const clash = await documentBelongsToPrimary(leadId, classified.fields);
    if (clash) {
      rejected.push(`${entry.name} — that ${clash} is the customer's`);
      continue;
    }

    const extracted = pickName(classified.fields);
    if (extracted) {
      const [lead] = await db
        .select({ full_name: leads.full_name })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1);
      if (lead?.full_name && namesMatch(lead.full_name, extracted)) {
        rejected.push(`${entry.name} — in the customer's own name`);
        continue;
      }
      if (name && !namesMatch(name, extracted)) {
        rejected.push(`${entry.name} — belongs to ${extracted}, not ${name}`);
        continue;
      }
      name ??= extracted;
    }

    const saved = await saveMedia({
      buffer: bytes,
      mimeType: mime,
      keyPrefix: `leads/${leadId}/whatsapp/coborrower`,
      docType,
      fileName: entry.name,
    });
    await persistCoBorrowerDoc({
      leadId,
      coBorrowerId: cb.coBorrowerId!,
      docType,
      saved,
      fields: classified.fields,
    });
    await applyExtractedFields(leadId, docType, classified.fields);
    docs[docType] = true;
    accepted.push(DOC_LABEL[docType] ?? docType);
  }

  await patchLeadSub(session.id, "cb", { docs, ...(name ? { name } : {}) });

  const left = pending(docs);
  const lines: string[] = [];
  if (accepted.length) lines.push(`✅ Received:\n${accepted.map((a) => `• ${a}`).join("\n")}`);
  if (rejected.length) lines.push(`⚠️ Skipped:\n${rejected.map((r) => `• ${r}`).join("\n")}`);
  if (left.length) {
    lines.push(`Still needed:\n${left.map((d) => `• ${DOC_LABEL[d]}`).join("\n")}`);
    await reply(session, lines.join("\n\n"));
    return;
  }

  await reply(session, lines.join("\n\n"));
  await startConsent(session, leadId);
}

function guessMime(fileName: string): string {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "pdf") return "application/pdf";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

function pickName(fields: Record<string, unknown>): string | null {
  const raw = fields.name ?? fields.full_name ?? fields.holder_name;
  return typeof raw === "string" && raw.trim().length >= 2 ? raw.trim() : null;
}

/**
 * Send a PDF as uploaded bytes and log it, mirroring the orchestrator's private
 * helper of the same name. Bytes rather than a link because our storage URLs sit
 * behind an authenticated proxy Meta cannot fetch.
 */
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
  await db.insert(whatsappMessages).values({
    session_id: session.id,
    provider_message_id: res.providerMessageId,
    direction: "outbound",
    message_type: "document",
    text_body: caption ?? null,
    delivery_status: res.ok ? "sent" : "failed",
    raw_payload: (res.raw ?? null) as never,
  });
}

/** Loose comparison — initials, middle names and ordering vary across IDs. */
function namesMatch(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .sort();
  const A = norm(a);
  const B = norm(b);
  if (A.length === 0 || B.length === 0) return false;
  const shared = A.filter((w) => B.includes(w)).length;
  return shared >= Math.min(2, Math.min(A.length, B.length));
}

/**
 * Fill co_borrowers from what the document actually says.
 *
 * This replaces six questions. Fields are only ever written when they are still
 * empty or the document is the authoritative source for them — a later document
 * must not silently overwrite a name established by the Aadhaar.
 *
 * Everything here lands on `co_borrowers` and NOWHERE else. The primary
 * borrower's `leads` / `personal_details` rows are off limits; see the file
 * header for why that mistake is so expensive.
 */
async function applyExtractedFields(
  leadId: string,
  docType: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const patch: Record<string, unknown> = {};
  const str = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : null;

  const name = str(fields.name ?? fields.full_name ?? fields.holder_name);
  const father = str(
    fields.fathers_name ?? fields.father_name ?? fields.father_husband_name,
  );
  const dob = str(fields.date_of_birth ?? fields.dob);
  const address = str(fields.address ?? fields.permanent_address);

  if (docType === "aadhaar_front") {
    const aadhaar = str(fields.aadhaar_number ?? fields.aadhaar_no)?.replace(/\D/g, "");
    if (aadhaar && aadhaar.length === 12) patch.aadhaar_no = aadhaar;
    if (name) patch.full_name = name;
    if (dob) {
      const iso = toIsoDob(dob);
      if (iso) patch.dob = iso;
    }
  }
  if (docType === "pan_card") {
    const pan = str(fields.pan_number ?? fields.pan_no)?.toUpperCase();
    if (pan && /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) patch.pan_no = pan;
    // PAN carries the father's name; Aadhaar generally does not.
    if (father) patch.father_or_husband_name = father;
    if (dob) {
      const iso = toIsoDob(dob);
      if (iso) patch.dob = iso;
    }
  }
  if (docType === "aadhaar_back" || docType === "address_proof") {
    if (address && address.length >= 10) {
      patch.permanent_address = address;
      patch.current_address = address;
      patch.is_current_same = true;
    }
  }

  if (Object.keys(patch).length === 0) return;

  // Never overwrite a value we already have from an earlier, equally valid
  // document — first read wins, so a blurry second scan cannot corrupt a good
  // first one.
  const [existing] = await db
    .select()
    .from(coBorrowers)
    .where(eq(coBorrowers.lead_id, leadId))
    .limit(1);
  if (existing) {
    for (const key of Object.keys(patch)) {
      const current = (existing as Record<string, unknown>)[key];
      if (current !== null && current !== undefined && current !== "") {
        delete patch[key];
      }
    }
  }
  if (Object.keys(patch).length === 0) return;

  patch.updated_at = new Date();
  await db.update(coBorrowers).set(patch as never).where(eq(coBorrowers.lead_id, leadId));
}

/** Gemini returns dates in several shapes; normalise to YYYY-MM-DD or give up. */
function toIsoDob(raw: string): string | null {
  const dmy = raw.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) return raw;
  return null;
}

/**
 * The co-borrower's identity documents must not be the customer's.
 *
 * The name check catches the obvious case, but names are fuzzy and a scan of
 * the applicant's own PAN with a slightly different spelling can slip through.
 * Aadhaar and PAN numbers are exact, so compare those against the primary
 * borrower's — a match means the same person is standing surety for themselves,
 * which is precisely what asking for a co-borrower is meant to prevent.
 */
async function documentBelongsToPrimary(
  leadId: string,
  fields: Record<string, unknown>,
): Promise<string | null> {
  const str = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  const aadhaar = str(fields.aadhaar_number ?? fields.aadhaar_no)?.replace(/\D/g, "");
  const pan = str(fields.pan_number ?? fields.pan_no)?.toUpperCase();
  if (!aadhaar && !pan) return null;

  const [pd] = await db
    .select({ aadhaar_no: personalDetails.aadhaar_no, pan_no: personalDetails.pan_no })
    .from(personalDetails)
    .where(eq(personalDetails.lead_id, leadId))
    .limit(1);
  if (!pd) return null;

  const primaryAadhaar = (pd.aadhaar_no ?? "").replace(/\D/g, "");
  if (aadhaar && primaryAadhaar && aadhaar === primaryAadhaar) return "Aadhaar";
  const primaryPan = (pd.pan_no ?? "").toUpperCase();
  if (pan && primaryPan && pan === primaryPan) return "PAN";
  return null;
}

/**
 * Write the document exactly where the web Step-3 flow writes it.
 *
 * kyc_documents with doc_for='borrower' is what the admin verification cards
 * read; co_borrower_documents is the legacy mirror that the older co-borrower
 * API still reads. Both, so neither surface is blind.
 */
async function persistCoBorrowerDoc(opts: {
  leadId: string;
  coBorrowerId: string;
  docType: string;
  saved: { fileUrl: string; fileName: string; fileSize: number; mimeType: string };
  fields: Record<string, unknown>;
}): Promise<void> {
  const { leadId, coBorrowerId, docType, saved, fields } = opts;
  const now = new Date();

  // Supersede any earlier attempt at this doc type, mirroring the primary path.
  await db
    .delete(kycDocuments)
    .where(
      and(
        eq(kycDocuments.lead_id, leadId),
        eq(kycDocuments.doc_type, docType),
        eq(kycDocuments.doc_for, "borrower"),
      ),
    );

  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = Math.floor(Math.random() * 10000).toString().padStart(4, "0");

  await db.insert(kycDocuments).values({
    id: `KYCDOC-${dateStr}-${seq}`,
    lead_id: leadId,
    doc_for: "borrower",
    doc_type: docType,
    file_url: saved.fileUrl,
    file_name: saved.fileName,
    file_type: saved.mimeType,
    file_size: saved.fileSize,
    verification_status: "pending",
    doc_status: "uploaded",
    ocr_data: fields as never,
    created_at: now,
    updated_at: now,
  });

  await db.insert(leadDocuments).values({
    id: crypto.randomUUID(),
    lead_id: leadId,
    type: docType,
    document_type: docType,
    url: saved.fileUrl,
    file_url: saved.fileUrl,
  });

  await db
    .delete(coBorrowerDocuments)
    .where(
      and(
        eq(coBorrowerDocuments.lead_id, leadId),
        eq(coBorrowerDocuments.document_type, docType),
      ),
    );
  await db.insert(coBorrowerDocuments).values({
    id: `COBDOC-${dateStr}-${seq}`,
    lead_id: leadId,
    co_borrower_id: coBorrowerId,
    document_type: docType,
    document_url: saved.fileUrl,
    file_name: saved.fileName,
    file_size: saved.fileSize,
    status: "pending",
    verification_status: "pending",
    ocr_data: fields as never,
    uploaded_at: now,
    created_at: now,
    updated_at: now,
  });
}

async function showReview(session: SessionRow, leadId: string): Promise<void> {
  const [cb] = await db
    .select()
    .from(coBorrowers)
    .where(eq(coBorrowers.lead_id, leadId))
    .orderBy(desc(coBorrowers.updated_at))
    .limit(1);

  const mask = (v: string | null, keep = 4) =>
    v ? `${"•".repeat(Math.max(0, v.length - keep))}${v.slice(-keep)}` : "—";

  await setSession(session.id, { current_state: DC_CB_REVIEW });
  await reply(
    session,
    `✅ *All documents received.*\n\nPlease check these details:\n\n` +
      `*Name:* ${cb?.full_name ?? "—"}\n` +
      `*Relation:* ${cb?.relationship ?? "—"}\n` +
      `*Mobile:* ${cb?.phone ?? "—"}\n` +
      `*Date of birth:* ${cb?.dob ?? "—"}\n` +
      `*Aadhaar:* ${mask(cb?.aadhaar_no ?? null)}\n` +
      `*PAN:* ${mask(cb?.pan_no ?? null)}\n\n` +
      `If anything is wrong, type *restart*. Otherwise tap Submit.`,
    [{ id: "cb_submit", title: "📤 Submit" }],
  );
}

/** DC_CB_REVIEW — submit, or start the details over. */
async function onCoBorrowerReview(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const { leadId } = cbCtx(session);
  if (!leadId) return await lostTrack(session);

  const t = text(event).toLowerCase();
  if (t === "restart") {
    await patchLeadSub(session.id, "cb", { qIndex: 0 });
    await setSession(session.id, { current_state: DC_CB_FIELD });
    await askQuestion(session, 0);
    return;
  }
  if (t !== "cb_submit" && t !== "submit") {
    await reply(session, "Tap *Submit* to send this to iTarang, or type *restart* to re-enter the details.", [
      { id: "cb_submit", title: "📤 Submit" },
    ]);
    return;
  }

  await submitCoBorrowerVerification(leadId);
  await setSession(session.id, { current_state: DC_CB_WAIT });
  await reply(
    session,
    "🎉 *Co-borrower submitted.*\n\nThe iTarang team is reviewing the details and " +
      "documents now. We'll message you here as soon as there's an update.",
  );
}

/** DC_CB_WAIT — parked. Anything sent here is an unprompted extra. */
async function onCoBorrowerWait(session: SessionRow): Promise<void> {
  await reply(
    session,
    "Your co-borrower details are with the iTarang team for review — nothing more is needed right now. " +
      "We'll message you here with the outcome.",
  );
}

async function lostTrack(session: SessionRow): Promise<void> {
  await reply(
    session,
    "I've lost track of which application this is for. Please send *hi* to start again.",
  );
}

registerLeadAction("cb_start", onCoBorrowerStart);
registerLeadAction("cb_later", async (session) => onCoBorrowerLater(session));
registerLeadState(DC_CB_FIELD, onCoBorrowerField);
registerLeadState(DC_CB_DOCS, onCoBorrowerDocs);
registerLeadState(DC_CB_CONSENT, onCoBorrowerConsent);
registerLeadState(DC_CB_CONSENT_OTP, onCoBorrowerConsentOtp);
registerLeadState(DC_CB_CONSENT_MANUAL, onCoBorrowerConsentManual);
registerLeadState(DC_CB_REVIEW, onCoBorrowerReview);
registerLeadState(DC_CB_WAIT, onCoBorrowerWait);
