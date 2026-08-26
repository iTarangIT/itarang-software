/**
 * Step-4 "extra documents" over WhatsApp — the ≤10 pre-sanction bucket.
 *
 * THE GAP THIS CLOSES.
 *
 * The web wizard's Step 4 has an optional card where the dealer attaches up to
 * ten files of any kind — photos, PDFs, Word documents, ZIPs, videos — that the
 * lenders see in their dossier before they sanction (E-208,
 * product_selections.pre_sanction_doc_urls). A lead run over WhatsApp had no
 * such step: the files could not be sent, and when an NBFC asked for "extra
 * Step-4 items" the ask reached the dealer as a generic document request whose
 * uploads landed in the Step-2/3 "Other Documentation" section, never in the
 * bucket the NBFC was actually looking at.
 *
 * This module gives the chat the same bucket, reachable three ways:
 *   • in the new-lead ladder, right after the KYC documents (optional — skip
 *     is one tap);
 *   • from the "Submit to iTarang" prompt and from Save Drafts, any time;
 *   • from an NBFC `step4_extra_items` request, which pushes a message naming
 *     the customer, the battery, the serial (when one has been picked) and the
 *     date, with a button that opens the bucket. Each file sent then ALSO
 *     answers the request's next open child, so the NBFC ⇄ admin loop closes
 *     the same way it does when the dealer uploads on the web.
 *
 * The bucket has ONE writer — src/lib/leads/pre-sanction-bucket.ts — shared with
 * the web PATCH route, so the two channels can never disagree on the cap, the
 * shape or which selection row the files belong to.
 */

import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";

import { db } from "@/lib/db/index";
import {
  leads,
  nbfcDocRequests,
  otherDocumentRequests,
  products,
} from "@/lib/db/schema";
import {
  type BucketItem,
  PRE_SANCTION_MAX,
  appendPreSanctionDocs,
  getPreSanctionBucket,
} from "@/lib/leads/pre-sanction-bucket";
import { notifyDocsShared } from "@/lib/notifications/events";

import type { ActiveDealer } from "./customer-lead";
import { getAdapter } from "./index";
import { leadActionId } from "./leadActionButton";
import { registerLeadAction } from "./leadActionReply";
import { pushToLead, resolveLeadTarget } from "./lead-push";
import { registerLeadState } from "./lead-states";
import {
  type Ctx,
  type SessionRow,
  loadSession,
  mergeContext,
  patchLeadSub,
  reply,
  setSession,
} from "./session-store";
import { saveMedia } from "./storage";
import type { InboundEvent, ReplyButton } from "./types";
import { oneLine } from "./window";

/** "Attach extra documents?" — the optional offer in the new-lead ladder. */
export const DC_XD_ASK = "DC_XD_ASK";
/** Accepting files into the bucket, one per message. */
export const DC_XD_WAIT = "DC_XD_WAIT";

/** Same per-file ceiling as the web card (videos allowed). */
const MAX_BYTES = 50 * 1024 * 1024;

const MAX_LISTED = 6;

type XdNext = NonNullable<NonNullable<Ctx["lead"]>["xd"]>["next"];

const ASK_BUTTONS: ReplyButton[] = [
  { id: "xd_add", title: "📎 Attach files" },
  { id: "xd_skip", title: "⏭️ Skip" },
];

// ---------------------------------------------------------------------------
// Continuation back into the orchestrator's ladder
// ---------------------------------------------------------------------------

/**
 * What happens when a batch ends in the new-lead ladder (`next` = consent or
 * submit). The orchestrator owns those steps and this module must not import
 * it (the phase modules depend on the orchestrator one way only), so it
 * registers the hand-back here at load time.
 */
export type ExtraDocsContinuation = (
  session: SessionRow,
  dealer: ActiveDealer,
  next: "consent" | "submit",
  leadId: string,
) => Promise<void>;

let continuation: ExtraDocsContinuation | null = null;

export function registerExtraDocsContinuation(fn: ExtraDocsContinuation): void {
  continuation = fn;
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

function xdCtx(session: SessionRow): {
  leadId?: string;
  xd: NonNullable<NonNullable<Ctx["lead"]>["xd"]>;
} {
  const ctx = (session.context ?? {}) as Ctx;
  return { leadId: ctx.lead?.leadId, xd: ctx.lead?.xd ?? {} };
}

function text(event: InboundEvent): string {
  return (event.text ?? "").trim();
}

const DONE_RE = /^(done|finish|finished|complete|completed|that'?s all|bas|ho gaya|hogaya|बस|हो गया|पूरा|poora|pura)$/i;
const LATER_RE = /^(later|stop|baad mein|baad me|ruko|band|बाद में|रुको|बंद)$/i;
const SKIP_RE = /^(xd_skip|skip|no|nahi|nahin|नहीं|nope|n)$/i;
const ADD_RE = /^(xd_add|add|yes|haan|ha|हाँ|हां|y|attach|upload)$/i;

function acceptsMedia(event: InboundEvent): boolean {
  return (
    event.type === "image" || event.type === "document" || event.type === "video"
  );
}

function counter(n: number): string {
  return `${n}/${PRE_SANCTION_MAX}`;
}

function nextFilePrompt(count: number): string {
  if (count >= PRE_SANCTION_MAX) {
    return `The bucket is full (${counter(count)}).`;
  }
  return (
    `Send file *${count + 1}* now — a photo, PDF, Word file, ZIP or video (up to 50 MB each). ` +
    `Type *done* when you've sent everything, or *later* to come back through *Save Drafts*.`
  );
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * The optional offer in the new-lead ladder. `next` says where the ladder
 * continues when the dealer skips or finishes.
 */
export async function askExtraDocs(
  session: SessionRow,
  _dealer: ActiveDealer,
  leadId: string,
  next: "consent" | "submit",
): Promise<void> {
  const { items } = await getPreSanctionBucket(leadId);
  await patchLeadSub(session.id, "xd", { count: items.length, next, batch: 0 });
  await setSession(session.id, { current_state: DC_XD_ASK });
  await reply(
    session,
    `📎 *Extra documents* (optional)\n\n` +
      `You can attach up to ${PRE_SANCTION_MAX} extra files for the lenders — photos, PDFs, Word files, ZIPs or videos.` +
      (items.length > 0 ? `\n\nAlready attached: ${counter(items.length)}.` : "") +
      `\n\nAttach now, or skip — you can add them any time from *Save Drafts*.`,
    ASK_BUTTONS,
  );
}

/** Park the chat on the bucket and ask for the first file. */
export async function openExtraDocs(
  session: SessionRow,
  leadId: string,
  opts: { next: XdNext; requestId?: string },
): Promise<void> {
  const { items } = await getPreSanctionBucket(leadId);
  await patchLeadSub(session.id, "xd", {
    count: items.length,
    next: opts.next ?? "menu",
    requestId: opts.requestId ?? null,
    batch: 0,
  });

  if (items.length >= PRE_SANCTION_MAX) {
    await reply(
      session,
      `📎 This application already has ${counter(items.length)} extra documents — the bucket is full. Remove one on the dealer portal to add another.`,
    );
    return await endBatch(session, null, leadId);
  }

  await setSession(session.id, { current_state: DC_XD_WAIT });
  let intro = `📎 *Extra documents* — ${counter(items.length)} attached.\n\n`;
  if (opts.requestId) {
    const pending = await openRequestChildren(opts.requestId);
    if (pending.length > 0) {
      const listed = pending.slice(0, MAX_LISTED).map((c) => `• *${c.doc_label}*`);
      if (pending.length > listed.length) {
        listed.push(`• …and ${pending.length - listed.length} more`);
      }
      intro += `The lender asked for:\n${listed.join("\n")}\n\nSend them in that order.\n\n`;
    }
  }
  await reply(session, intro + nextFilePrompt(items.length));
}

// ---------------------------------------------------------------------------
// DC_XD_ASK
// ---------------------------------------------------------------------------

async function onExtraDocsAsk(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  const { leadId, xd } = xdCtx(session);
  if (!leadId) return await lostTrack(session);
  const t = text(event).toLowerCase();

  if (ADD_RE.test(t) || acceptsMedia(event)) {
    await openExtraDocs(session, leadId, { next: xd.next ?? "consent" });
    if (acceptsMedia(event)) {
      // They answered the question by sending the file. Ingest it.
      return await onExtraDocsWait(await loadSession(session.id), event, dealer);
    }
    return;
  }
  if (SKIP_RE.test(t)) {
    const next = xd.next === "submit" ? "submit" : "consent";
    return await continueLadder(session, dealer, leadId, next);
  }
  await reply(
    session,
    "Tap *Attach files* to add up to 10 extra documents, or *Skip* to continue.",
    ASK_BUTTONS,
  );
}

// ---------------------------------------------------------------------------
// DC_XD_WAIT — one file per message
// ---------------------------------------------------------------------------

async function onExtraDocsWait(
  session: SessionRow,
  event: InboundEvent,
  dealer: ActiveDealer,
): Promise<void> {
  const { leadId, xd } = xdCtx(session);
  if (!leadId) return await lostTrack(session);

  if (!acceptsMedia(event)) {
    const t = text(event).toLowerCase();
    if (DONE_RE.test(t)) return await endBatch(session, dealer, leadId);
    if (LATER_RE.test(t)) return await parkForLater(session, leadId);
    await reply(
      session,
      `Please send the file as a *photo*, *PDF*, *document*, *ZIP* or *video*.\n\n` +
        `Type *done* when finished (${counter(xd.count ?? 0)} attached), or *later* to come back via *Save Drafts*.`,
    );
    return;
  }

  if (!event.mediaProviderId) {
    await reply(session, "That file didn't come through. Please send it again.");
    return;
  }

  // downloadMedia THROWS on a bad media id or an expired Meta URL, and saveMedia
  // throws on a storage failure — both recoverable by simply resending, so say
  // so rather than letting the turn's outer handler answer "something went
  // wrong", which reads as "stop trying".
  let item: BucketItem;
  try {
    const media = await getAdapter().downloadMedia(event.mediaProviderId);
    if (media.buffer.length > MAX_BYTES) {
      await reply(
        session,
        "⚠️ That file is over 50 MB, so it wasn't saved. Please send a smaller file (or a compressed ZIP).",
      );
      return;
    }
    const mimeType = media.mimeType || event.mimeType || "application/octet-stream";
    const saved = await saveMedia({
      buffer: media.buffer,
      mimeType,
      keyPrefix: `leads/${leadId}/whatsapp/extra`,
      docType: "extra_document",
      fileName: media.fileName ?? event.fileName,
    });
    item = {
      url: saved.fileUrl,
      name: saved.fileName,
      type: saved.mimeType,
      size: saved.fileSize,
    };
  } catch (err) {
    console.error("[WhatsApp/extra-docs] media fetch/store failed:", err);
    await reply(session, "I couldn't save that file — please send it once more.");
    return;
  }

  const result = await appendPreSanctionDocs(leadId, [item], {
    createDraftIfMissing: true,
    submittedBy: dealer.uploaderId,
  });
  if (result.dropped > 0) {
    await reply(
      session,
      `⚠️ The bucket is already full (${counter(result.items.length)}), so that file wasn't added.`,
    );
    return await endBatch(session, dealer, leadId);
  }

  // NBFC-initiated: the file also answers the request's next open child, so
  // the wrapper re-projects and the admin is notified exactly as a web upload.
  let answered: string | null = null;
  if (xd.requestId) {
    answered = await fulfilNextRequestChild(xd.requestId, item.url);
  }

  const count = result.items.length;
  await patchLeadSub(session.id, "xd", { count, batch: (xd.batch ?? 0) + 1 });

  if (count >= PRE_SANCTION_MAX) {
    await reply(session, `✅ Saved *${item.name}* (${counter(count)}). That's the maximum.`);
    return await endBatch(await loadSession(session.id), dealer, leadId);
  }

  const got = answered
    ? `✅ Got *${answered}* (${counter(count)}).`
    : `✅ Saved *${item.name}* (${counter(count)}).`;
  let follow = "";
  if (xd.requestId) {
    const pending = await openRequestChildren(xd.requestId);
    if (pending.length > 0) {
      follow = `\n\nNext, please send *${pending[0].doc_label}*.`;
    } else {
      follow = `\n\nThat covers what the lender asked for. Send more if you like, or type *done*.`;
    }
  } else {
    follow = `\n\nSend the next file, or type *done*.`;
  }
  await reply(session, got + follow);
}

// ---------------------------------------------------------------------------
// Ending a batch
// ---------------------------------------------------------------------------

async function endBatch(
  session: SessionRow,
  dealer: ActiveDealer | null,
  leadId: string,
): Promise<void> {
  const fresh = await loadSession(session.id);
  const { xd } = xdCtx(fresh);

  // One notification per batch, not per file — the PATCH route's reasoning.
  if ((xd.batch ?? 0) > 0) {
    try {
      await notifyDocsShared({
        leadId,
        docLabel: "pre-sanction documents",
        count: xd.batch ?? 0,
        dealerName: dealer?.dealerName ?? null,
        stage: "Step 4 · Pre-sanction documents",
      });
    } catch (err) {
      console.error("[WhatsApp/extra-docs] notifyDocsShared failed:", err);
    }
  }
  await patchLeadSub(session.id, "xd", { batch: 0 });

  const next = xd.next ?? "menu";
  if ((next === "consent" || next === "submit") && dealer) {
    return await continueLadder(fresh, dealer, leadId, next);
  }

  await setSession(session.id, { current_state: "DC_MENU" });
  await reply(
    fresh,
    `📎 ${counter(xd.count ?? 0)} extra documents are attached to this application` +
      (xd.requestId ? " — iTarang will review them and pass them to the lender." : ".") +
      `\n\nSend *menu* to continue.`,
  );
}

async function continueLadder(
  session: SessionRow,
  dealer: ActiveDealer,
  leadId: string,
  next: "consent" | "submit",
): Promise<void> {
  if (!continuation) {
    console.error("[WhatsApp/extra-docs] no continuation registered; falling back to menu");
    await setSession(session.id, { current_state: "DC_MENU" });
    await reply(session, "Saved. Send *menu* to continue.");
    return;
  }
  await continuation(await loadSession(session.id), dealer, next, leadId);
}

/**
 * "later" — leave the lead reachable from Save Drafts. A pre-submit draft is
 * listed from the DB already; a submitted lead is not, so snapshot it into
 * ctx.parked the way parkCurrentLead does for the other journey phases.
 */
async function parkForLater(session: SessionRow, leadId: string): Promise<void> {
  await mergeContext(session, (ctx) => {
    const lead = ctx.lead ?? {};
    ctx.parked = {
      ...(ctx.parked ?? {}),
      [leadId]: {
        state: DC_XD_WAIT,
        lead: { ...lead, leadId },
        at: new Date().toISOString(),
      },
    };
    ctx.lead = undefined;
  });
  await setSession(session.id, { current_state: "DC_MENU" });
  await reply(
    session,
    "No problem — this application is in *Save Drafts* under *Extra documents*. Open it there whenever you're ready to send more files.",
  );
}

async function lostTrack(session: SessionRow): Promise<void> {
  await setSession(session.id, { current_state: "DC_MENU" });
  await reply(
    session,
    "I've lost track of which application this is for. Please send *hi* and start again.",
  );
}

// ---------------------------------------------------------------------------
// NBFC request plumbing
// ---------------------------------------------------------------------------

async function openRequestChildren(requestId: string) {
  return await db
    .select({
      id: otherDocumentRequests.id,
      doc_label: otherDocumentRequests.doc_label,
    })
    .from(otherDocumentRequests)
    .where(
      and(
        eq(otherDocumentRequests.nbfc_request_id, requestId),
        or(
          eq(otherDocumentRequests.upload_status, "not_uploaded"),
          isNull(otherDocumentRequests.upload_status),
        ),
      ),
    )
    .orderBy(asc(otherDocumentRequests.created_at));
}

/** Attach the file to the oldest open child; returns its label, or null when none was open. */
async function fulfilNextRequestChild(
  requestId: string,
  fileUrl: string,
): Promise<string | null> {
  const [target] = await openRequestChildren(requestId);
  if (!target) return null;
  // The same three columns the public upload route writes.
  await db
    .update(otherDocumentRequests)
    .set({ file_url: fileUrl, upload_status: "uploaded", uploaded_at: new Date() })
    .where(eq(otherDocumentRequests.id, target.id));
  try {
    const { recomputeWrapperStatus } = await import("@/lib/nbfc/doc-requests");
    await recomputeWrapperStatus(requestId);
  } catch (err) {
    console.error("[WhatsApp/extra-docs] wrapper reproject failed:", err);
  }
  return target.doc_label;
}

/** The newest open step4_extra_items request on this lead, if any. */
async function openStep4Request(leadId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: nbfcDocRequests.id })
    .from(nbfcDocRequests)
    .where(
      and(
        eq(nbfcDocRequests.lead_id, leadId),
        eq(nbfcDocRequests.request_type, "step4_extra_items"),
        inArray(nbfcDocRequests.status, ["forwarded_to_dealer", "with_customer"]),
      ),
    )
    .orderBy(desc(nbfcDocRequests.created_at))
    .limit(1);
  return row?.id ?? null;
}

/** `xd_start:<leadId>` — open the bucket from a push (or a re-tap). */
async function onExtraDocsStart(
  session: SessionRow,
  _event: InboundEvent,
  _dealer: ActiveDealer,
  leadId: string,
): Promise<void> {
  const requestId = await openStep4Request(leadId);
  // A tap re-hydrates the lead pointer; forget any snapshot parked for it.
  await mergeContext(session, (ctx) => {
    if (ctx.parked) delete ctx.parked[leadId];
  });
  await openExtraDocs(await loadSession(session.id), leadId, {
    next: "menu",
    requestId: requestId ?? undefined,
  });
}

/** Save Drafts re-opened a parked DC_XD_WAIT: restate where we are. */
async function resumeExtraDocs(
  session: SessionRow,
  _dealer: ActiveDealer,
): Promise<void> {
  const { leadId, xd } = xdCtx(session);
  if (!leadId) return await lostTrack(session);
  await openExtraDocs(session, leadId, {
    next: xd.next ?? "menu",
    requestId: xd.requestId ?? (await openStep4Request(leadId)) ?? undefined,
  });
}

// ---------------------------------------------------------------------------
// The push: NBFC asked for extra Step-4 items
// ---------------------------------------------------------------------------

export interface ExtraDocsRequestItem {
  id: string;
  docLabel: string;
  reason?: string | null;
}

/**
 * Tell whoever is driving this lead on WhatsApp that a lender wants extra
 * Step-4 documents, and leave the lead in their Save Drafts under "Extra
 * documents" so it can be picked up later without the message.
 *
 * Best-effort by contract: called `void … .catch()` from forwardNbfcDocRequest,
 * so a WhatsApp failure can never fail the forward.
 */
export async function pushExtraDocsRequest(opts: {
  leadId: string;
  requestId: string;
  items: ExtraDocsRequestItem[];
}): Promise<void> {
  const { leadId, requestId, items } = opts;

  const [lead] = await db
    .select({
      full_name: leads.full_name,
      owner_name: leads.owner_name,
      mobile: leads.mobile,
      owner_contact: leads.owner_contact,
      reference_id: leads.reference_id,
      asset_model: leads.asset_model,
      product_name: products.name,
    })
    .from(leads)
    .leftJoin(products, eq(products.id, leads.product_type_id))
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return;

  const { batterySerial, items: bucket } = await getPreSanctionBucket(leadId);
  const battery = lead.asset_model || lead.product_name || "Battery (model not chosen yet)";
  const date = new Date().toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  const listed = items.slice(0, MAX_LISTED).map((i) => {
    const reason = i.reason?.trim();
    return reason ? `• *${i.docLabel}* — ${reason}` : `• *${i.docLabel}*`;
  });
  if (items.length > listed.length) {
    listed.push(`• …and ${items.length - listed.length} more`);
  }

  const result = await pushToLead(leadId, (t) => {
    const whose =
      t.audience === "dealer" ? `${t.customerName}'s application` : "your application";
    return {
      prompt: {
        kind: "text",
        body:
          `📎 *Extra documents requested*\n\n` +
          `Hi ${t.greetName}, a lending partner needs extra documents for ${whose}:\n\n` +
          `👤 Customer: ${t.customerName}\n` +
          `🔋 Battery: ${battery}\n` +
          `🔢 Serial: ${batterySerial ?? "— (not picked yet)"}\n` +
          `🧾 Ref: ${t.referenceId}\n` +
          `📅 Date: ${date}\n\n` +
          `${listed.join("\n")}\n\n` +
          `${counter(bucket.length)} already attached. Tap *Send files* to add them here now, ` +
          `or open *Save Drafts → ${t.customerName} · Extra documents* later.`,
        buttons: [{ id: leadActionId("xd_start", leadId), title: "📎 Send files" }],
      },
      nudge: {
        template: "lead_action",
        params: [
          oneLine(t.greetName),
          oneLine(t.referenceId),
          oneLine(
            items.length === 1
              ? `${items[0].docLabel} is needed (extra documents)`
              : `${items.length} extra documents are needed`,
          ),
        ],
      },
    };
  });

  // Park it in Save Drafts so the ask survives the message scrolling away.
  // Skipped when that chat is already live on this lead (its handler owns the
  // state) or when nobody has a chat at all (a cold push creates one on reply,
  // and the button re-hydrates from the database).
  if (result === "none") return;
  try {
    const target = await resolveLeadTarget(leadId);
    const session = target?.session;
    if (!session) return;
    const ctx = (session.context ?? {}) as Ctx;
    if (ctx.lead?.leadId === leadId && session.current_state.startsWith("DC_XD_")) return;
    const customerName =
      (lead.full_name || lead.owner_name || target.customerName || "Customer").trim();
    await mergeContext(session, (c) => {
      c.parked = {
        ...(c.parked ?? {}),
        [leadId]: {
          state: DC_XD_WAIT,
          lead: {
            leadId,
            customerName,
            mobile: lead.mobile || lead.owner_contact || undefined,
            xd: { requestId, next: "menu", count: bucket.length, batch: 0 },
          },
          at: new Date().toISOString(),
        },
      };
    });
  } catch (err) {
    console.error("[WhatsApp/extra-docs] park for Save Drafts failed:", err);
  }
}

// ---------------------------------------------------------------------------

registerLeadAction("xd_start", onExtraDocsStart);
// Both states take a tap or a file, never free text as payload, and answer
// unrecognised text by restating the prompt — so a greeting re-renders rather
// than abandons. The explicit resume lets Save Drafts re-open the bucket.
registerLeadState(DC_XD_ASK, onExtraDocsAsk, { rerenderOnGreeting: true });
registerLeadState(DC_XD_WAIT, onExtraDocsWait, {
  rerenderOnGreeting: true,
  resume: resumeExtraDocs,
});
