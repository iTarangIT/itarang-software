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

/** What the chat says when Next-file is tapped. */
export const DOC_NEXT_PROMPT = "Send the next file now (photo or PDF).";

/** "✅ Got it (n attached)." — the acknowledgement after each accepted file. */
export function docGotIt(attached: number): string {
  return `✅ Got it (${attached} attached).`;
}
