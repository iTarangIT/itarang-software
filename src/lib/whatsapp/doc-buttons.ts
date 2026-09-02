/**
 * E-275 — the "Next file / Done" buttons on every document batch.
 *
 * Every place the chat accepts a run of files (customer KYC documents, an
 * admin/NBFC document request, the Step-4 extra bucket) used to end its prompt
 * with "type *done*". Typed words are the least discoverable affordance on
 * WhatsApp; a tapped button is one thumb. These ids are shared so the three
 * flows cannot drift into three different button vocabularies.
 *
 * PURE — no I/O. The ids are NOT `LEAD_ACTIONS` prefixes on purpose: they must
 * reach the state handler that owns the batch as ordinary text (the same
 * convention `s4p:` / `ofp:` rows use), so the handler sees the tap exactly
 * where it would have seen a typed "done".
 *
 * Typed "done" keeps working everywhere — `isDocDone` accepts the button id OR
 * the words the handlers already recognised.
 */

import type { ReplyButton } from "./types";

export const DOC_NEXT_ID = "docs_next";
export const DOC_DONE_ID = "docs_done";

/** The two buttons, in the order they should appear. */
export function docBatchButtons(): ReplyButton[] {
  return [
    { id: DOC_NEXT_ID, title: "📎 Next file" },
    { id: DOC_DONE_ID, title: "✅ Done" },
  ];
}

const DONE_WORDS =
  /^(done|finish|finished|complete|completed|that'?s all|bas|ho gaya|hogaya|बस|हो गया|पूरा|poora|pura)$/i;

/** The Done button, or any of the typed "done" spellings the flows accept. */
export function isDocDone(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return t === DOC_DONE_ID || DONE_WORDS.test(t);
}

/** The Next-file button (or "next" typed). */
export function isDocNext(text: string | null | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase();
  return t === DOC_NEXT_ID || t === "next" || t === "next file";
}

// --- "Still needed" follow-up ---------------------------------------------
// After a batch lands with required documents still missing, the summary ends
// with two choices instead of the generic Next/Done pair: SKIP the rest and
// move on (they can be added later on the portal), or SEND — which restates
// exactly which documents are still needed and waits for them.

export const DOC_SKIP_ID = "docs_skip";
export const DOC_SEND_ID = "docs_send";

/** The two buttons shown under a "Still needed" list. */
export function docMissingButtons(): ReplyButton[] {
  return [
    { id: DOC_SKIP_ID, title: "⏭ Skip" },
    { id: DOC_SEND_ID, title: "📎 Send document" },
  ];
}

/** The Skip button, or "skip" typed. */
export function isDocSkip(text: string | null | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase();
  return t === DOC_SKIP_ID || t === "skip";
}

/** The Send button, or "send" typed. */
export function isDocSend(text: string | null | undefined): boolean {
  const t = (text ?? "").trim().toLowerCase();
  return t === DOC_SEND_ID || t === "send";
}

/** "Please send the *RC copy* now …" — what Send replies with. */
export function docSendPrompt(missingLabels: string[]): string {
  const list = missingLabels.map((l) => `• *${l}*`).join("\n");
  return (
    `Please send the following document${missingLabels.length > 1 ? "s" : ""} now (photo or PDF):\n${list}` +
    `\n\nSend them one by one or as a ZIP — I'll continue automatically once they are in.`
  );
}

/** What the chat says when Next-file is tapped. */
export const DOC_NEXT_PROMPT = "Send the next file now (photo or PDF).";

/** "✅ Got it (n attached)." — the acknowledgement after each accepted file. */
export function docGotIt(attached: number): string {
  return `✅ Got it (${attached} attached).`;
}
