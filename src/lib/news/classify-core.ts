/**
 * Green Energy News — classification prompt + response parsing (E-306).
 * Pure (no DB, no network) so it is unit tested without a connection string.
 */

import {
  NEWS_CATEGORY_KEYS,
  isNewsCategory,
  isNewsRegion,
  type NewsCategory,
  type NewsRegion,
} from "./categories";
import { clip } from "./normalize";

export type ClassifyInput = {
  id: string;
  title: string;
  snippet: string | null;
  sourceName: string | null;
  regionHint?: NewsRegion | null;
};

export type ClassifyResult = {
  region: NewsRegion;
  category: NewsCategory;
  relevance: number;
  summary: string;
};

export const CLASSIFY_BATCH_SIZE = 25;

export function buildClassifyPrompt(items: ClassifyInput[]): string {
  const lines = [
    "You tag news items for the CEO of iTarang, an Indian company that runs a dealer network for electric-vehicle (e-rickshaw / e-3W) lithium batteries, arranges battery loans through NBFCs, and works in green energy (solar, storage, charging).",
    "",
    "For EACH item return:",
    `- region: "india" if the story is about India or an Indian company/policy, else "world".`,
    `- category: one of ${NEWS_CATEGORY_KEYS.map((k) => `"${k}"`).join(", ")}.`,
    "    policy_subsidy     = government policy, subsidies, tariffs, regulation, targets (PM E-DRIVE, FAME, PLI, net-metering, RBI/NBFC rules for green loans)",
    "    funding_investment = funding rounds, grants, green bonds, M&A, project finance, where the money comes from",
    "    ev_battery         = EVs, e-rickshaws, lithium / sodium batteries, battery swapping, battery recycling, battery finance",
    "    solar_wind         = solar, wind, hydro, hydrogen generation projects and manufacturing",
    "    grid_storage       = grid, transmission, distribution, discoms, energy storage / BESS, smart meters",
    "    business_model     = how companies and people are earning money from green energy: new products, pricing, leasing, franchises, dealer networks, revenue results",
    "    other              = green energy but none of the above",
    "- relevance: 0-100. 100 = directly about EV battery finance / dealers / e-rickshaws in India; 70 = Indian green-energy policy, funding or grid news; 50 = notable world green-energy news; below 40 = not green energy at all, celebrity/sports/politics with no energy angle, job ads, or pure stock-tip spam.",
    "- summary: ONE plain-English sentence (max 30 words) saying what happened and why it matters. No hype, no 'this article'.",
    "",
    `Respond with ONLY a JSON object: {"items":[{"id":"...","region":"india","category":"ev_battery","relevance":85,"summary":"..."}, ...]} — one entry per input id, same ids.`,
    "",
    "INPUT:",
    JSON.stringify(
      {
        items: items.map((i) => ({
          id: i.id,
          title: i.title,
          source: i.sourceName ?? "",
          hint: i.regionHint ?? "",
          text: clip(i.snippet ?? "", 400),
        })),
      },
      null,
      0,
    ),
  ];
  return lines.join("\n");
}

type RawItem = { id?: unknown; region?: unknown; category?: unknown; relevance?: unknown; summary?: unknown };

/** Pure: model JSON → map of id → result. Unknown ids and bad rows are dropped. */
export function parseClassifyResponse(
  parsed: unknown,
  expectedIds: string[],
  hints: Map<string, NewsRegion | null | undefined> = new Map(),
): Map<string, ClassifyResult> {
  const out = new Map<string, ClassifyResult>();
  const rows = (parsed as { items?: unknown } | null)?.items;
  if (!Array.isArray(rows)) return out;
  const allowed = new Set(expectedIds);
  for (const r of rows as RawItem[]) {
    const id = typeof r?.id === "string" ? r.id : null;
    if (!id || !allowed.has(id) || out.has(id)) continue;
    const relevanceNum = Number(r.relevance);
    const relevance = Number.isFinite(relevanceNum) ? Math.max(0, Math.min(100, Math.round(relevanceNum))) : 50;
    const region: NewsRegion = isNewsRegion(r.region) ? r.region : (hints.get(id) ?? "world");
    const category: NewsCategory = isNewsCategory(r.category) ? r.category : "other";
    const summary = typeof r.summary === "string" ? clip(r.summary.trim(), 300) : "";
    out.set(id, { region, category, relevance, summary });
  }
  return out;
}
