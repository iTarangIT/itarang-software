/**
 * Fit score 0–100 with a one-line reason (doc §9). The LLM never sends
 * anything; it only reads the public profile fields and the admin's keywords.
 */
import { askJson } from "./llm";

export type ScoreInput = {
  id: string;
  full_name: string | null;
  headline: string | null;
  company: string | null;
  city: string | null;
};
export type Score = { id: string; score: number; reason: string };

const SYSTEM = `You score LinkedIn profiles for B2B outreach by iTarang Technologies (lithium batteries, EV battery finance and dealer network, India).
Given the admin's search keywords and a list of profiles, return ONLY JSON: {"scores":[{"id":"...","score":0-100,"reason":"one short line"}]}.
Score how well each profile matches the keywords and is a plausible decision maker. Use only the fields given; do not invent facts.`;

/** Clamp and validate a model answer. Pure; exported for tests. */
export function parseScores(raw: unknown, ids: Set<string>): Score[] {
  const list = (raw && typeof raw === "object" && Array.isArray((raw as { scores?: unknown }).scores)
    ? (raw as { scores: unknown[] }).scores
    : Array.isArray(raw)
      ? raw
      : []) as Record<string, unknown>[];
  const out: Score[] = [];
  for (const s of list) {
    const id = typeof s?.id === "string" ? s.id : null;
    if (!id || !ids.has(id)) continue;
    const n = Math.round(Number(s.score));
    if (!Number.isFinite(n)) continue;
    out.push({
      id,
      score: Math.max(0, Math.min(100, n)),
      reason: String(s.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
    });
  }
  return out;
}

export async function scoreProfiles(keywords: string, profiles: ScoreInput[]): Promise<Score[]> {
  const out: Score[] = [];
  for (let i = 0; i < profiles.length; i += 25) {
    const batch = profiles.slice(i, i + 25);
    const raw = await askJson(
      SYSTEM,
      JSON.stringify({
        keywords,
        profiles: batch.map((p) => ({
          id: p.id,
          name: p.full_name,
          headline: p.headline,
          company: p.company,
          city: p.city,
        })),
      }),
    );
    out.push(...parseScores(raw, new Set(batch.map((b) => b.id))));
  }
  return out;
}
