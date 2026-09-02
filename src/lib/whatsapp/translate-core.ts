/**
 * Translation types + pure helpers (no DB, no network). See translate.ts for
 * the Gemini + cache implementation that uses these.
 */

import { createHash } from "node:crypto";

import type { WhatsAppLanguage } from "./language";

/** Where a string is going — decides the Meta length cap and the register. */
export type TranslationKind =
  | "body"
  | "button"
  | "row_title"
  | "row_desc"
  | "list_button"
  | "caption";

/** Meta's hard limits per slot (types.ts documents the same numbers). */
export const KIND_MAX_CHARS: Record<TranslationKind, number | null> = {
  body: null,
  button: 20,
  row_title: 24,
  row_desc: 72,
  list_button: 20,
  caption: 1024,
};

export interface TranslationItem {
  text: string;
  kind: TranslationKind;
}

/** Injectable translator (tests pass a stub). */
export type BatchTranslator = (
  items: TranslationItem[],
  lang: WhatsAppLanguage,
) => Promise<string[]>;

export function translationHash(kind: TranslationKind, text: string): string {
  return createHash("sha256").update(`${kind}\n${text}`).digest("hex");
}

/**
 * Hard guard for Meta's per-slot caps. The prompt asks the model to fit; this
 * is the belt to that brace, because an overlong title fails the whole send.
 */
export function fitToKind(text: string, kind: TranslationKind): string {
  const max = KIND_MAX_CHARS[kind];
  if (max === null || [...text].length <= max) return text;
  const chars = [...text];
  return chars.slice(0, max - 1).join("").trimEnd() + "…";
}
