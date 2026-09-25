/**
 * Green Energy News — brief prompt + response parsing (E-306). Pure.
 */

import { NEWS_CATEGORIES } from "./categories";
import { clip } from "./normalize";

export type BriefBullet = { text: string; item_ids: string[] };

export const BRIEF_EARLIEST_IST_HOUR = 6;
export const BRIEF_ITEM_LIMIT = 30;

type BriefInput = {
  id: string;
  title: string;
  summary: string | null;
  region: string | null;
  category: string | null;
  sourceName: string | null;
};

export function buildBriefPrompt(items: BriefInput[], istDate: string): string {
  return [
    `You write the morning green-energy brief for ${istDate} for the CEO of iTarang — an Indian EV-battery dealer network that also arranges battery loans through NBFCs and works in solar and storage.`,
    "",
    "From the items below write EXACTLY 5 bullets, in this order of priority: (1) India policy / subsidies, (2) funding & investment (where the money is coming from), (3) EV & batteries, (4) grid, distribution & storage, (5) how companies are earning money / business models. If a theme has nothing today, use the slot for the next most important story instead.",
    "Each bullet: one or two plain sentences, max 45 words, specific (name the company / state / amount). No hype, no emojis, no headings. Cite the ids of the items the bullet is based on.",
    "",
    `Respond with ONLY a JSON object: {"bullets":[{"text":"...","item_ids":["..."]}, ...]} — 5 entries.`,
    "",
    "ITEMS:",
    JSON.stringify(
      {
        items: items.map((i) => ({
          id: i.id,
          region: i.region ?? "",
          category: i.category ? (NEWS_CATEGORIES as Record<string, string>)[i.category] ?? i.category : "",
          source: i.sourceName ?? "",
          title: i.title,
          summary: clip(i.summary ?? "", 240),
        })),
      },
      null,
      0,
    ),
  ].join("\n");
}

/** Pure: model JSON → bullets. Drops empty text and ids we did not send. */
export function parseBriefResponse(parsed: unknown, allowedIds: string[]): BriefBullet[] {
  const rows = (parsed as { bullets?: unknown } | null)?.bullets;
  if (!Array.isArray(rows)) return [];
  const allowed = new Set(allowedIds);
  const out: BriefBullet[] = [];
  for (const r of rows as { text?: unknown; item_ids?: unknown }[]) {
    const text = typeof r?.text === "string" ? r.text.trim() : "";
    if (!text) continue;
    const ids = Array.isArray(r.item_ids)
      ? (r.item_ids as unknown[]).filter((x): x is string => typeof x === "string" && allowed.has(x))
      : [];
    out.push({ text: clip(text, 400), item_ids: ids });
    if (out.length === 5) break;
  }
  return out;
}
