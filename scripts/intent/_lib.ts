// Shared types + helpers for the intent-scoring eval/tuning scripts.
//
// The "golden set" is the set of human corrections (intent_score_feedback)
// joined to the call's transcript + signals. Each row is one benchmark case:
// a transcript, the human's true label, and (optionally) per-signal corrections.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import dotenv from "dotenv";
import type { IntentSignals, LeadStatus } from "@/lib/ai/scoring";

export const LEAD_STATUSES: LeadStatus[] = ["qualified", "warm", "cold", "disqualified"];

// Which environment a correction came from. Reviewers correct calls on both the
// sandbox (sandbox.itarang.com) and production (crm.itarang.com) dashboards.
export type DbSource = "sandbox" | "prod";

export interface GoldenCase {
  callId: string;
  leadId: string | null;
  transcript: string | null;
  // Human ground truth (corrected_status).
  label: LeadStatus;
  correctedScore: number | null;
  // What the AI produced at review time.
  originalIntentScore: number | null;
  originalSignals: IntentSignals | null;
  // Human per-signal fixes (deep mode), when provided.
  correctedSignals: IntentSignals | null;
  // Which DB this correction was made in.
  source: DbSource;
  // ISO timestamp of the correction — used to dedupe (most-recent wins) when the
  // same call was corrected in both environments.
  createdAt: string;
}

// ── Multi-DB connection (sandbox + production) ───────────────────────────────
// Both databases use the SAME `DATABASE_URL` var name, differentiated by env
// file: sandbox lives in `.env.local`, production in `.env.production` (mirrors
// scripts/db-drift.ts). Scripts that read prod do SELECT-only — never writes.

export interface DbTarget {
  label: DbSource;
  url: string;
}

const REPO_ROOT = process.cwd();

// Canonical per-script postgres client (mirrors scripts/db-helpers/introspect.ts).
export function makeClient(url: string) {
  return postgres(url, {
    ssl: "require",
    prepare: false,
    max: 2,
    idle_timeout: 5,
    connect_timeout: 15,
  });
}

// Read DATABASE_URL out of a specific env file without mutating process.env.
function readUrlFromEnvFile(...candidates: string[]): string | null {
  for (const rel of candidates) {
    const file = path.join(REPO_ROOT, rel);
    if (!existsSync(file)) continue;
    try {
      const parsed = dotenv.parse(readFileSync(file, "utf8"));
      if (parsed.DATABASE_URL) return parsed.DATABASE_URL;
    } catch {
      // fall through to next candidate
    }
  }
  return null;
}

// `--db=sandbox|prod|both` flag (or INTENT_DB env). Default "both".
export function parseDbSelector(argv: string[]): "sandbox" | "prod" | "both" {
  const flag = argv.find((a) => a.startsWith("--db="))?.split("=")[1];
  const val = (flag ?? process.env.INTENT_DB ?? "both").toLowerCase();
  if (val === "sandbox" || val === "prod" || val === "both") return val;
  console.warn(`Unknown --db=${val}; defaulting to "both".`);
  return "both";
}

// Resolve the requested selector to concrete {label,url} targets. Warns and
// skips a target whose URL can't be found rather than crashing the whole run.
export function resolveTargets(selector: "sandbox" | "prod" | "both"): DbTarget[] {
  const out: DbTarget[] = [];
  const want = (s: DbSource) => selector === "both" || selector === s;
  if (want("sandbox")) {
    const url = readUrlFromEnvFile(".env.local");
    if (url) out.push({ label: "sandbox", url });
    else console.warn("sandbox: no DATABASE_URL in .env.local — skipping.");
  }
  if (want("prod")) {
    const url = readUrlFromEnvFile(".env.production", "keys/.env.production");
    if (url) out.push({ label: "prod", url });
    else console.warn("prod: no DATABASE_URL in .env.production — skipping.");
  }
  return out;
}

// Repo-root-relative path to the materialized golden fixture.
export const GOLDEN_PATH = path.resolve(
  process.cwd(),
  "src/lib/ai/scoring/__tests__/fixtures/golden.json",
);

export async function writeGolden(cases: GoldenCase[]): Promise<void> {
  const dir = path.dirname(GOLDEN_PATH);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(GOLDEN_PATH, JSON.stringify(cases, null, 2) + "\n", "utf8");
}

export async function readGolden(): Promise<GoldenCase[]> {
  if (!existsSync(GOLDEN_PATH)) {
    throw new Error(
      `No golden fixture at ${GOLDEN_PATH}. Run \`npm run intent:export-golden\` first.`,
    );
  }
  return JSON.parse(await readFile(GOLDEN_PATH, "utf8")) as GoldenCase[];
}

// The signals to treat as ground truth for a case: a human's per-signal
// correction when present, else what the LLM extracted at review time.
export function truthSignals(c: GoldenCase): IntentSignals | null {
  return c.correctedSignals ?? c.originalSignals ?? null;
}

// The yes/no facts a reviewer can correct — the keys whose extraction accuracy
// we report. Mirrors CORRECTABLE_FACTS in the drawer.
export const LEVELED_KEYS = [
  "relevant_dealer",
  "battery_spec_shared",
  "volume_shared",
  "existing_financier_shared",
  "financing_need_expressed",
  "financing_value_acknowledged",
  "pitch_heard",
  "callback_agreed",
  "disqualifier",
] as const;

// The yes/no (or disqualifier enum) value of a fact, for per-signal accuracy.
export function signalLevel(signals: IntentSignals | null, key: string): string {
  if (!signals) return "no";
  const v = (signals as unknown as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "no";
}

// Pretty confusion matrix over a fixed label order. Returns lines to print.
export function confusionMatrix(
  pairs: Array<{ truth: string; pred: string }>,
  order: readonly string[],
): string[] {
  const counts: Record<string, Record<string, number>> = {};
  for (const t of order) {
    counts[t] = {};
    for (const p of order) counts[t][p] = 0;
  }
  for (const { truth, pred } of pairs) {
    if (counts[truth] && counts[truth][pred] != null) counts[truth][pred]++;
  }
  const w = Math.max(12, ...order.map((o) => o.length + 2));
  const pad = (s: string) => s.padEnd(w);
  const lines: string[] = [];
  lines.push(pad("truth ↓ / pred →") + order.map((o) => pad(o)).join(""));
  for (const t of order) {
    lines.push(pad(t) + order.map((p) => pad(String(counts[t][p]))).join(""));
  }
  return lines;
}

export function accuracy(pairs: Array<{ truth: string; pred: string }>): number {
  if (pairs.length === 0) return 0;
  const hits = pairs.filter((p) => p.truth === p.pred).length;
  return hits / pairs.length;
}
