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

import { and, desc, eq, inArray, notInArray } from "drizzle-orm";

import { db } from "@/lib/db/index";
import {
  dealerCorrectionItems,
  dealerCorrectionRounds,
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
  whatsappMessages,
  whatsappOnboardingSessions,
} from "@/lib/db/schema";

import JSZip from "jszip";

import {
  documentLabel as correctionDocumentLabel,
  fieldLabel as correctionFieldLabel,
} from "@/lib/onboarding/correction-catalog";
import { buildGstAddresses } from "@/lib/onboarding/gst-addresses";
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
import { classifyDocument } from "./extraction";
import { maskAccount, maskGstin, maskIfsc, maskPan } from "./masking";
import { removeMedia, saveMedia } from "./storage";
import type { InboundEvent, ReplyButton } from "./types";

const MIN_CONFIDENCE = Number(process.env.WHATSAPP_MIN_CONFIDENCE ?? 0.55);
const PLACEHOLDER_COMPANY = "WhatsApp onboarding (pending)";

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
  /(^|\b)(no|nope|nah|nahi+|naa+|n\/?a|skip|next|proceed|continue|move\s*(on|ahead|forward|further)|don'?t\s*have|do\s*not\s*have|have\s*not|haven'?t|not?\s*avai\w*|un\s*avai\w*|no\s*(doc|document|more)|only\s*this|this\s*(is\s*)?(all|only)|have\s*this\s*only|that'?s\s*all|nothing\s*else|can'?t\s*(get|provide|share|do)|cannot\s*(get|provide|share|do)|nahi\s*hai|aage\s*(badho|chalo))(\b|$)/i;

// Company-type choices shown as tappable reply buttons (WhatsApp allows ≤3).
// The button id IS the canonical CompanyType, so a tap maps straight through
// with no free-text parsing. LLP is intentionally not offered here.
const COMPANY_TYPE_BUTTONS: ReplyButton[] = [
  { id: "sole_proprietorship", title: "Sole Proprietor" },
  { id: "partnership_firm", title: "Partnership" },
  { id: "private_limited_firm", title: "Private Limited" },
];

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
  if (/^(yes|y|haan|ha|sure|yep)$/i.test(t)) return true;
  if (/^(no|n|nahi|nope)$/i.test(t)) return false;
  return null;
}

/** Validate an interactive button id as a CompanyType. */
function asCompanyType(id: string | null | undefined): CompanyType | null {
  return id && KNOWN_COMPANY_TYPES.includes(id) ? (id as CompanyType) : null;
}

type SessionRow = typeof whatsappOnboardingSessions.$inferSelect;
type Ctx = {
  answers?: Record<string, unknown>;
  docs?: Record<string, { fields: Record<string, unknown>; confidence: number }>;
  fieldIndex?: number;
  /** Index into SIGNER_FIELDS while the dealer is re-entering the signer
   *  (owner) name/phone/email via the "Change" button on the signer confirm. */
  signerIndex?: number;
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
};

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

  const session = await getOrCreateSession(event);
  await setSession(session.id, { last_inbound_at: new Date() });

  try {
    // A greeting word (hi/hello/onboarding/start…) restarts the flow from the
    // welcome + company-type question — unless the dealer has already submitted
    // (then we keep the "under review" reply), or the session is brand-new and
    // already in GREETING (the switch handles that below).
    if (isGreetingTrigger(event, session)) {
      return await restartOnboarding(session);
    }

    switch (session.current_state) {
      case "GREETING":
        return await onGreeting(session);
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
  // Welcome + the company-type question in a SINGLE interactive message — one
  // Meta round-trip instead of two, so the dealer's first reply is faster.
  await askCompanyType(
    session,
    "👋 Welcome to *iTarang* dealer onboarding!\n\nWe'll collect your business documents right here on WhatsApp. It only takes a few minutes.",
  );
}

// True when a typed message should restart the flow: a greeting word, in any
// state except SUBMITTED (keep the "under review" reply) and GREETING (the
// switch already runs onGreeting there).
function isGreetingTrigger(event: InboundEvent, session: SessionRow): boolean {
  if (event.type !== "text") return false;
  // SUBMITTED / GREETING keep their own replies; CORRECTION / REJECTED are
  // post-submission states where a stray "hi" must NOT wipe progress — the
  // dealer is mid-correction or already declined.
  if (
    session.current_state === "SUBMITTED" ||
    session.current_state === "GREETING" ||
    session.current_state === "CORRECTION" ||
    session.current_state === "REJECTED"
  ) {
    return false;
  }
  return GREETING_TRIGGERS.test((event.text ?? "").trim());
}

// Clear any collected progress and re-greet, so "hi" mid-flow is a genuine
// fresh start. The application row + session are kept (same dealer); only the
// in-conversation context is reset.
async function restartOnboarding(session: SessionRow): Promise<void> {
  await mergeContext(session, (ctx) => {
    ctx.docs = {};
    ctx.answers = {};
    ctx.fieldIndex = 0;
    ctx.skipped = [];
    ctx.attempts = {};
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
async function askCompanyType(
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
    await mergeContext(session, (ctx) => {
      ctx.signerIndex = 0;
    });
    await setSession(session.id, { current_state: "ASK_SIGNER_FIELD" });
    await reply(session, "No problem — let's update the signer details.");
    const fresh = await loadSession(session.id);
    await reply(fresh, SIGNER_FIELDS[0].question);
    return;
  }
  await reply(
    session,
    "Tap *Correct* to submit, or *Change* to edit the signer details.",
  );
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
  });
  await patchApplication(session.application_id, fieldToColumn(field.key, parsed));

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
  };
  roundId: string;
  roundNumber: number;
  remarks: string;
  requestedFields: string[]; // catalog field keys
  requestedDocuments: string[]; // catalog document keys
}): Promise<{ ok: boolean; error?: string }> {
  const { application, roundId, roundNumber, remarks } = params;

  // Locate the dealer's session: prefer the linked one, else latest by phone.
  let session: SessionRow | undefined;
  if (application.wa_session_id) {
    session = await loadSession(application.wa_session_id);
  }
  if (!session && application.wa_phone) {
    const [row] = await db
      .select()
      .from(whatsappOnboardingSessions)
      .where(eq(whatsappOnboardingSessions.wa_phone, application.wa_phone))
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
    case "gst":
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
      await setGstAddressesSnapshot(
        session.application_id,
        buildGstAddresses(fields) as unknown as Record<string, any>,
      );
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
    case "company_pan":
      if (str(fields.pan)) patch.pan_number = str(fields.pan);
      break;
    case "bank_statement":
    case "cancelled_cheque": {
      if (str(fields.bank_name)) patch.bank_name = str(fields.bank_name);
      if (str(fields.account_number)) patch.account_number = str(fields.account_number);
      if (str(fields.ifsc)) patch.ifsc_code = str(fields.ifsc);
      if (str(fields.account_holder_name)) patch.beneficiary_name = str(fields.account_holder_name);
      // Bank branch + account type, and (for a sole proprietorship) the account
      // holder's address as the owner residential address. These have no columns
      // — they live in the ownership snapshot the admin page reads.
      const ownership: Record<string, unknown> = {
        branch: str(fields.branch),
        accountType: str(fields.account_type),
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
