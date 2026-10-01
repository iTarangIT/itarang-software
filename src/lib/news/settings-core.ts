/**
 * Green Energy News — settings shape + defaults (E-306). Pure; no DB import so
 * unit tests and the sources list can use it without a connection string.
 */

import { DEFAULT_MIN_RELEVANCE } from "./categories";

export const GREEN_NEWS_SETTINGS_KEY = "green_news";

export type GreenNewsSettings = {
  enabled: boolean;
  /** Extra RSS / Atom URLs on top of DEFAULT_SOURCES. */
  extraFeeds: string[];
  /** Extra Google News search queries. */
  extraQueries: string[];
  /** Items below this relevance are hidden. */
  minRelevance: number;
};

export const DEFAULT_GREEN_NEWS_SETTINGS: GreenNewsSettings = {
  enabled: true,
  extraFeeds: [],
  extraQueries: [],
  minRelevance: DEFAULT_MIN_RELEVANCE,
};

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
}

/** Pure: stored JSON → complete settings. */
export function normalizeGreenNewsSettings(raw: unknown): GreenNewsSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const min = Number(r.minRelevance);
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_GREEN_NEWS_SETTINGS.enabled,
    extraFeeds: strings(r.extraFeeds),
    extraQueries: strings(r.extraQueries),
    minRelevance: Number.isFinite(min) ? Math.max(0, Math.min(100, Math.round(min))) : DEFAULT_MIN_RELEVANCE,
  };
}
