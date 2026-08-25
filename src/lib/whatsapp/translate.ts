/**
 * Outbound message translation (English → Hindi / Hinglish) via Gemini.
 *
 * WHY TRANSLATE THE RENDERED STRING. Every bot message in this module is an
 * inline English template literal with amounts, names, serials and OTPs baked
 * in — ~330 sites, no key layer. Translating the final rendered text at the
 * adapter boundary (see translating-adapter.ts) localises all of them without
 * touching a single call site, at the cost of one Gemini round-trip per
 * DISTINCT string. Fixed copy (menus, buttons, prompts) is distinct once and
 * then served from cache; only strings carrying fresh dynamic values miss.
 *
 * Two cache tiers: an in-process LRU for the hot path, and the
 * `whatsapp_translations` table (E-269) so a restart or a second process does
 * not re-pay for the same menu. The table is OPTIONAL — every DB touch is
 * wrapped so an environment where E-269 is not applied degrades to LRU-only
 * with one warning, and never blocks a send.
 *
 * FAIL OPEN. A missing key, a timeout or garbage JSON returns the English
 * input unchanged. A customer receiving English is a degraded experience; a
 * customer receiving nothing is a lost lead.
 */

import { eq, sql, and } from "drizzle-orm";

import { db } from "@/lib/db";
import { whatsappTranslations } from "@/lib/db/schema";

import type { WhatsAppLanguage } from "./language";
import {
  fitToKind,
  translationHash,
  type TranslationItem,
  type TranslationKind,
} from "./translate-core";

export {
  KIND_MAX_CHARS,
  fitToKind,
  translationHash,
  type BatchTranslator,
  type TranslationItem,
  type TranslationKind,
} from "./translate-core";

const MODEL =
  process.env.GEMINI_WHATSAPP_TRANSLATE_MODEL ||
  process.env.GEMINI_WHATSAPP_MODEL ||
  "gemini-flash-lite-latest";

const GENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = Number(process.env.WA_TRANSLATE_TIMEOUT_MS || 6000);
const LRU_MAX = 2000;

function apiKey(): string {
  return (
    process.env.GEMINI_WHATSAPP_API_KEY || process.env.GEMINI_API_KEY || ""
  );
}

// ---------------------------------------------------------------------------
// Cache keys

// In-process LRU (Map keeps insertion order; re-insert on hit to refresh).
const lru = new Map<string, string>();

function lruKey(hash: string, lang: WhatsAppLanguage): string {
  return `${lang}:${hash}`;
}

function lruGet(key: string): string | undefined {
  const v = lru.get(key);
  if (v === undefined) return undefined;
  lru.delete(key);
  lru.set(key, v);
  return v;
}

function lruSet(key: string, value: string): void {
  if (lru.has(key)) lru.delete(key);
  lru.set(key, value);
  if (lru.size > LRU_MAX) {
    const oldest = lru.keys().next().value;
    if (oldest !== undefined) lru.delete(oldest);
  }
}

/** Test hook. */
export function clearTranslationCache(): void {
  lru.clear();
}

// DB tier — every call guarded; one warning per process if the table is absent.
let dbTierDisabled = false;

function disableDbTier(err: unknown): void {
  if (dbTierDisabled) return;
  dbTierDisabled = true;
  console.warn(
    "[WhatsApp/translate] whatsapp_translations unavailable (E-269 not applied?) — using in-memory cache only:",
    err instanceof Error ? err.message : err,
  );
}

async function dbGetMany(
  hashes: string[],
  lang: WhatsAppLanguage,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (dbTierDisabled || hashes.length === 0) return out;
  try {
    const rows = await db
      .select({
        source_hash: whatsappTranslations.source_hash,
        translated_text: whatsappTranslations.translated_text,
      })
      .from(whatsappTranslations)
      .where(
        and(
          eq(whatsappTranslations.language, lang),
          sql`${whatsappTranslations.source_hash} IN (${sql.join(
            hashes.map((h) => sql`${h}`),
            sql`, `,
          )})`,
        ),
      );
    for (const r of rows) out.set(r.source_hash, r.translated_text);
    if (rows.length) {
      // Fire-and-forget usage bump; never awaited on the send path.
      void db
        .update(whatsappTranslations)
        .set({
          hit_count: sql`${whatsappTranslations.hit_count} + 1`,
          last_used_at: new Date(),
        })
        .where(
          and(
            eq(whatsappTranslations.language, lang),
            sql`${whatsappTranslations.source_hash} IN (${sql.join(
              rows.map((r) => sql`${r.source_hash}`),
              sql`, `,
            )})`,
          ),
        )
        .catch(() => {});
    }
  } catch (err) {
    disableDbTier(err);
  }
  return out;
}

async function dbPut(
  entries: {
    hash: string;
    kind: TranslationKind;
    source: string;
    translated: string;
  }[],
  lang: WhatsAppLanguage,
): Promise<void> {
  if (dbTierDisabled || entries.length === 0) return;
  try {
    await db
      .insert(whatsappTranslations)
      .values(
        entries.map((e) => ({
          source_hash: e.hash,
          language: lang,
          kind: e.kind,
          source_text: e.source,
          translated_text: e.translated,
          model: MODEL,
        })),
      )
      .onConflictDoNothing();
  } catch (err) {
    disableDbTier(err);
  }
}

// ---------------------------------------------------------------------------
// Gemini

const LANGUAGE_INSTRUCTION: Record<Exclude<WhatsAppLanguage, "english">, string> =
  {
    hindi:
      "Target language: HINDI written in Devanagari script (शुद्ध पर सरल बोलचाल की हिंदी). Common English product/finance words that Indian users normally say in English (EMI, OTP, KYC, PAN, Aadhaar, GST, NBFC, loan, battery model names) may stay in English letters.",
    hinglish:
      "Target language: HINGLISH — everyday spoken Hindi written in ROMAN (English) letters, mixed naturally with common English words, the way people type on WhatsApp in India (e.g. 'Aapka OTP 4821 hai', 'Kripya apna Aadhaar bhejein'). Do NOT use Devanagari script.",
  };

function buildPrompt(items: TranslationItem[], lang: WhatsAppLanguage): string {
  const rules = [
    "You translate WhatsApp bot messages for iTarang, an Indian EV-battery dealer network, from English.",
    LANGUAGE_INSTRUCTION[lang as Exclude<WhatsAppLanguage, "english">],
    "",
    "STRICT RULES:",
    "- Keep EXACTLY as-is (character for character): every number, ₹ amount, OTP, date, time, phone number, serial / battery / lead id, URL, email address, person name, company name, product / model name, emoji, and any code-like token.",
    "- Keep WhatsApp formatting: *bold*, _italic_, ~strike~, ```mono```, line breaks, bullet characters and emoji must stay in the same positions.",
    "- Keep the same tone (polite, short, clear). Do not add greetings, explanations or extra sentences. Do not drop information.",
    "- Return one translation per input item, in the same order.",
    "- Length caps by kind — the platform REJECTS longer text, so shorten wording (never the numbers/ids) to fit: button ≤ 20 characters, list_button ≤ 20, row_title ≤ 24, row_desc ≤ 72. body and caption have no cap.",
    "",
    "Respond with ONLY a JSON object of the form {\"items\":[\"...\",\"...\"]} — one string per input, no commentary.",
    "",
    "INPUT:",
    JSON.stringify(
      { items: items.map((i) => ({ kind: i.kind, text: i.text })) },
      null,
      0,
    ),
  ];
  return rules.join("\n");
}

function safeParse(raw: string): { items?: unknown } | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function callGemini(
  items: TranslationItem[],
  lang: WhatsAppLanguage,
): Promise<string[] | null> {
  const key = apiKey();
  if (!key) {
    console.warn("[WhatsApp/translate] no Gemini key — sending English");
    return null;
  }

  const requestBody = JSON.stringify({
    contents: [{ parts: [{ text: buildPrompt(items, lang) }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      maxOutputTokens: 4096,
    },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${GENAI_BASE}/${MODEL}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(
        "[WhatsApp/translate] Gemini error:",
        data?.error?.message ?? `gemini_http_${res.status}`,
      );
      return null;
    }
    const raw: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    const parsed = safeParse(raw);
    const out = parsed?.items;
    if (!Array.isArray(out) || out.length !== items.length) {
      console.error(
        `[WhatsApp/translate] expected ${items.length} items, got ${Array.isArray(out) ? out.length : "non-array"}`,
      );
      return null;
    }
    return out.map((v, i) =>
      typeof v === "string" && v.trim() ? v : items[i].text,
    );
  } catch (err) {
    console.error(
      "[WhatsApp/translate] Gemini call failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Translate a batch of strings that belong to ONE outbound message. Returns
 * an array aligned with `items`; any item that could not be translated comes
 * back as its English input. Never throws.
 */
export async function translateBatch(
  items: TranslationItem[],
  lang: WhatsAppLanguage,
): Promise<string[]> {
  if (lang === "english" || items.length === 0) {
    return items.map((i) => i.text);
  }

  const result: (string | undefined)[] = new Array(items.length);
  const hashes = items.map((i) => translationHash(i.kind, i.text));

  // Tier 1 — LRU. Blank/whitespace-only strings never go to the model.
  const missIdx: number[] = [];
  items.forEach((item, i) => {
    if (!item.text.trim()) {
      result[i] = item.text;
      return;
    }
    const hit = lruGet(lruKey(hashes[i], lang));
    if (hit !== undefined) result[i] = hit;
    else missIdx.push(i);
  });

  // Tier 2 — DB.
  if (missIdx.length) {
    const fromDb = await dbGetMany(
      missIdx.map((i) => hashes[i]),
      lang,
    );
    for (const i of [...missIdx]) {
      const v = fromDb.get(hashes[i]);
      if (v !== undefined) {
        result[i] = v;
        lruSet(lruKey(hashes[i], lang), v);
        missIdx.splice(missIdx.indexOf(i), 1);
      }
    }
  }

  // Tier 3 — Gemini, deduplicated by hash within the batch.
  if (missIdx.length) {
    const uniq = new Map<string, number>(); // hash -> first index
    for (const i of missIdx) if (!uniq.has(hashes[i])) uniq.set(hashes[i], i);
    const askIdx = [...uniq.values()];
    const translated = await callGemini(
      askIdx.map((i) => items[i]),
      lang,
    );

    if (translated) {
      const byHash = new Map<string, string>();
      askIdx.forEach((i, k) => {
        const fitted = fitToKind(translated[k], items[i].kind);
        byHash.set(hashes[i], fitted);
      });
      for (const i of missIdx) {
        const v = byHash.get(hashes[i]) ?? items[i].text;
        result[i] = v;
        lruSet(lruKey(hashes[i], lang), v);
      }
      await dbPut(
        askIdx.map((i) => ({
          hash: hashes[i],
          kind: items[i].kind,
          source: items[i].text,
          translated: byHash.get(hashes[i]) ?? items[i].text,
        })),
        lang,
      );
    } else {
      for (const i of missIdx) result[i] = items[i].text;
    }
  }

  return result.map((v, i) => v ?? items[i].text);
}
