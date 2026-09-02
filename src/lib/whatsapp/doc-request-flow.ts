/**
 * E-264 — admin/NBFC document requests, delivered to and answered on WhatsApp.
 *
 * THE GAP THIS CLOSES.
 *
 * When an admin uses "Request Docs" on the KYC review screen, the route creates
 * one `other_document_requests` row per item, mints a 7-day upload token, and
 * returns an upload link — which nothing then delivers. The route's own header
 * says outreach "is triggered from the dealer dashboard's existing Send Link
 * buttons", and the SM equivalent carries a literal
 * `// TODO: Send via SMS/WhatsApp` where the send should be. So the admin's
 * screen reads "Awaiting upload from dealer / customer…" while the customer has
 * been told nothing at all.
 *
 * For a lead whose documents arrived over WhatsApp in the first place, the fix
 * has to be symmetric: ask on the channel they were already using, and let them
 * answer by doing what they have already done five times — sending a photo.
 *
 * So a request produces BOTH affordances:
 *   • the existing web upload link, which needs no session and already works;
 *   • a "Send here" button that parks the chat and ingests the next photo/PDF,
 *     writing exactly the columns the public upload route writes, so the admin
 *     screen cannot tell which route the file came in by.
 */

import { and, desc, eq, isNull, or } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { otherDocumentRequests } from "@/lib/db/schema";

import type { ActiveDealer } from "./customer-lead";
import {
  DOC_NEXT_PROMPT,
  docBatchButtons,
  docGotIt,
  isDocDone,
  isDocNext,
} from "./doc-buttons";
import { getAdapter } from "./index";
import { leadActionId } from "./leadActionButton";
import { registerLeadAction } from "./leadActionReply";
import { pushToLead } from "./lead-push";
import { registerLeadState } from "./lead-states";
import { patchLeadSub, reply, setSession, type SessionRow } from "./session-store";
import { saveMedia } from "./storage";
import type { InboundEvent } from "./types";
import { oneLine } from "./window";

/** Waiting for the customer or dealer to send a requested document. */
export const DC_DOCREQ_WAIT = "DC_DOCREQ_WAIT";

const MAX_LISTED = 6;

export interface DocRequestItem {
  id: string;
  docLabel: string;
  uploadLink: string;
  reason?: string | null;
}

/**
 * Tell whoever is driving this lead on WhatsApp that documents are needed.
 *
 * Best-effort by contract: called with `void … .catch()` from the admin route so
 * a WhatsApp failure can never fail the admin's action or roll back the rows
 * that were just created.
 */
export async function pushDocRequestToWhatsApp(opts: {
  leadId: string;
  items: DocRequestItem[];
  docFor?: "primary" | "co_borrower";
}): Promise<void> {
  const { leadId, items, docFor = "primary" } = opts;
  if (items.length === 0) return;

  const listed = items.slice(0, MAX_LISTED);
  const lines = listed.map((i) => {
    const reason = i.reason?.trim();
    return reason ? `• *${i.docLabel}* — ${reason}` : `• *${i.docLabel}*`;
  });
  if (items.length > listed.length) {
    lines.push(`• …and ${items.length - listed.length} more`);
  }

  // One link when there is one item. With several, each row has its OWN token
  // and its own link, so pointing at a single one would silently drop the rest
  // — send them all rather than pretend one covers everything.
  const links =
    listed.length === 1
      ? `\n\nUpload here: ${listed[0].uploadLink}`
      : `\n\n${listed.map((i) => `${i.docLabel}: ${i.uploadLink}`).join("\n")}`;

  const plural = items.length > 1;

  await pushToLead(leadId, (t) => {
    // "your document" is right for the customer and wrong for the dealer, who
    // is being asked for somebody else's paperwork.
    const whose =
      t.audience === "dealer"
        ? docFor === "co_borrower"
          ? `${t.customerName}'s co-borrower's`
          : `${t.customerName}'s`
        : docFor === "co_borrower"
          ? "the co-borrower's"
          : "your";

    return {
      prompt: {
        kind: "text",
        body:
          `📄 *Document request*\n\n` +
          `Hi ${t.greetName}, iTarang needs ${whose} document${plural ? "s" : ""} ` +
          `for application ${t.referenceId}:\n\n${lines.join("\n")}` +
          `\n\nTap *Send here* and photograph ${plural ? "them" : "it"} ` +
          `in this chat, or use the link${listed.length > 1 ? "s" : ""} below.` +
          links,
        buttons: [{ id: leadActionId("dr_send", leadId), title: "📎 Send here" }],
      },
      nudge: {
        template: "lead_action",
        params: [
          oneLine(t.greetName),
          oneLine(t.referenceId),
          oneLine(
            items.length === 1
              ? `${items[0].docLabel} is needed`
              : `${items.length} documents are needed`,
          ),
        ],
      },
    };
  });
}

/** Open (not-yet-uploaded, unexpired) requests for a lead, oldest first. */
async function openRequests(leadId: string) {
  return await db
    .select({
      id: otherDocumentRequests.id,
      doc_label: otherDocumentRequests.doc_label,
      doc_key: otherDocumentRequests.doc_key,
      doc_for: otherDocumentRequests.doc_for,
      nbfc_request_id: otherDocumentRequests.nbfc_request_id,
    })
    .from(otherDocumentRequests)
    .where(
      and(
        eq(otherDocumentRequests.lead_id, leadId),
        or(
          eq(otherDocumentRequests.upload_status, "not_uploaded"),
          isNull(otherDocumentRequests.upload_status),
        ),
      ),
    )
    .orderBy(desc(otherDocumentRequests.created_at));
}

/** `dr_send:<leadId>` — park the chat and start accepting files. */
async function onDocRequestStart(
  session: SessionRow,
  _event: InboundEvent,
  _dealer: ActiveDealer,
  leadId: string,
): Promise<void> {
  const open = await openRequests(leadId);
  if (open.length === 0) {
    await reply(
      session,
      "✅ Nothing is pending on this application right now — everything we asked for has been received.",
    );
    return;
  }

  await patchLeadSub(session.id, "dr", { pending: open.length });
  await setSession(session.id, { current_state: DC_DOCREQ_WAIT });
  await reply(
    session,
    `Please send *${open[0].doc_label}* now — a clear photo or a PDF is fine.` +
      (open.length > 1
        ? `\n\n${open.length} documents are pending; send them one at a time and I'll tell you what's left.`
        : ""),
    docBatchButtons(),
  );
}

/**
 * DC_DOCREQ_WAIT — a file arrived. Attach it to the oldest open request.
 *
 * Deliberately does NOT try to work out which request a photo satisfies. The
 * admin asks for named items in order, the bot asks for them in the same order,
 * and one file answers the one currently being asked for. Guessing from image
 * content would mean silently filing a bank statement against "Passport Size
 * Photo", which is worse than asking.
 */
async function onDocRequestWait(
  session: SessionRow,
  event: InboundEvent,
): Promise<void> {
  const ctx = (session.context ?? {}) as { lead?: { leadId?: string } };
  const leadId = ctx.lead?.leadId;
  if (!leadId) {
    await reply(
      session,
      "I've lost track of which application this is for. Please send *hi* and start again.",
    );
    return;
  }

  if (event.type !== "image" && event.type !== "document") {
    const text = (event.text ?? "").trim().toLowerCase();
    if (isDocNext(text)) {
      await reply(session, DOC_NEXT_PROMPT, docBatchButtons());
      return;
    }
    if (
      isDocDone(text) ||
      /^(later|stop|baad mein|baad me|ruko|band|बाद में|रुको|बंद)$/.test(text)
    ) {
      await setSession(session.id, { current_state: "DC_MENU" });
      await reply(
        session,
        "No problem — the upload link stays valid for 7 days. Send *hi* whenever you're ready.",
      );
      return;
    }
    await reply(
      session,
      "Please send the document as a *photo* or a *PDF*. Type *later* to do it another time.",
      docBatchButtons(),
    );
    return;
  }

  const open = await openRequests(leadId);
  if (open.length === 0) {
    await setSession(session.id, { current_state: "DC_MENU" });
    await reply(
      session,
      "✅ Everything we asked for has already been received — thank you.",
    );
    return;
  }

  const target = open[0];

  if (!event.mediaProviderId) {
    await reply(session, "That file didn't come through. Please send it again.");
    return;
  }

  // downloadMedia THROWS on a bad media id or an expired Meta URL, and saveMedia
  // throws on a storage failure. Both are recoverable by the customer simply
  // sending the photo again, so catch them here and say so — letting them bubble
  // to the turn's outer handler produces "something went wrong on our side",
  // which reads as "stop trying".
  let saved;
  try {
    const media = await getAdapter().downloadMedia(event.mediaProviderId);
    saved = await saveMedia({
      buffer: media.buffer,
      mimeType: media.mimeType || event.mimeType || "application/octet-stream",
      keyPrefix: `leads/${leadId}/whatsapp/docreq`,
      docType: target.doc_key || "requested_doc",
      fileName: media.fileName ?? event.fileName,
    });
  } catch (err) {
    console.error("[WhatsApp/docreq] media fetch/store failed:", err);
    await reply(
      session,
      "I couldn't save that file — please send it once more.",
    );
    return;
  }

  // The same three columns the public upload route writes, so the admin screen
  // cannot tell which channel the file arrived on.
  await db
    .update(otherDocumentRequests)
    .set({
      file_url: saved.fileUrl,
      upload_status: "uploaded",
      uploaded_at: new Date(),
    })
    .where(eq(otherDocumentRequests.id, target.id));

  // E-200 — an NBFC-originated child re-projects its wrapper and notifies the
  // admins, exactly as the web upload does. Best-effort: a notification failure
  // must not lose the file we have already stored.
  if (target.nbfc_request_id) {
    try {
      const { recomputeWrapperStatus } = await import("@/lib/nbfc/doc-requests");
      await recomputeWrapperStatus(target.nbfc_request_id);
    } catch (err) {
      console.error("[WhatsApp/docreq] wrapper reproject failed:", err);
    }
  }

  const remaining = open.length - 1;
  if (remaining > 0) {
    await patchLeadSub(session.id, "dr", { pending: remaining });
    await reply(
      session,
      `${docGotIt(open.length - remaining)} *${target.doc_label}*\n\nNext, please send *${open[1].doc_label}*.`,
      docBatchButtons(),
    );
    return;
  }

  await patchLeadSub(session.id, "dr", { pending: 0 });
  await setSession(session.id, { current_state: "DC_MENU" });
  await reply(
    session,
    `✅ Got *${target.doc_label}*. That's everything — iTarang will review it and come back to you.`,
  );
}

registerLeadAction("dr_send", onDocRequestStart);
// Expects a photo or a PDF — text is never the payload, and the handler
// already answers unrecognised text by restating what it needs.
registerLeadState(DC_DOCREQ_WAIT, onDocRequestWait, { rerenderOnGreeting: true });
