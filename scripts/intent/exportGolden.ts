// Materialize the golden/benchmark set from human corrections — across BOTH the
// sandbox and production databases.
//
//   npm run intent:export-golden                # both DBs, merged (default)
//   npm run intent:export-golden -- --db=prod    # production only
//   npm run intent:export-golden -- --db=sandbox # sandbox only
//
// Reviewers correct calls on both sandbox.itarang.com and crm.itarang.com, so the
// answer key must include both. This reads intent_score_feedback (joined to
// ai_call_logs for the transcript) from each selected DB — SELECT-only, never
// writes — tags each case with its source, then dedupes by call_id keeping the
// MOST RECENT correction (a call corrected in both environments appears once).
// Output: src/lib/ai/scoring/__tests__/fixtures/golden.json.

import type { IntentSignals, LeadStatus } from "@/lib/ai/scoring";
import {
  GOLDEN_PATH,
  LEAD_STATUSES,
  writeGolden,
  makeClient,
  parseDbSelector,
  resolveTargets,
  type GoldenCase,
  type DbTarget,
} from "./_lib";

interface Row {
  call_id: string;
  lead_id: string | null;
  corrected_status: string;
  corrected_score: number | null;
  corrected_signals: IntentSignals | null;
  original_intent_score: number | null;
  original_signals: IntentSignals | null;
  created_at: Date | string;
  transcript: string | null;
}

// A signals blob is band-shaped (QualificationSignals) if it carries the yes/no
// facts. Old BANT corrections (budget/need levels) are nulled out so the band
// rubric never replays a stale signal shape; their label-only correction is
// dropped too (no signals → not a rubric case).
function bandSignalsOrNull(s: IntentSignals | null): IntentSignals | null {
  if (!s || typeof s !== "object") return null;
  const o = s as unknown as Record<string, unknown>;
  return typeof o.callback_agreed === "string" || typeof o.relevant_dealer === "string"
    ? s
    : null;
}

async function fetchFromTarget(target: DbTarget): Promise<GoldenCase[]> {
  const sql = makeClient(target.url);
  try {
    const rows = (await sql<Row[]>`
      SELECT f.call_id, f.lead_id, f.corrected_status, f.corrected_score,
             f.corrected_signals, f.original_intent_score, f.original_signals,
             f.created_at, c.transcript
      FROM intent_score_feedback f
      LEFT JOIN ai_call_logs c ON c.call_id = f.call_id
      ORDER BY f.created_at DESC
    `) as unknown as Row[];

    return rows
      .filter((r) => LEAD_STATUSES.includes(r.corrected_status as LeadStatus))
      .map((r) => ({
        callId: r.call_id,
        leadId: r.lead_id ?? null,
        transcript: r.transcript ?? null,
        label: r.corrected_status as LeadStatus,
        correctedScore: r.corrected_score ?? null,
        originalIntentScore: r.original_intent_score ?? null,
        originalSignals: bandSignalsOrNull(r.original_signals),
        correctedSignals: bandSignalsOrNull(r.corrected_signals),
        source: target.label,
        createdAt:
          r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      }));
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "42P01") {
      console.warn(
        `${target.label}: intent_score_feedback table missing — apply drizzle/E-159 there; skipping.`,
      );
      return [];
    }
    throw err;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  const selector = parseDbSelector(process.argv.slice(2));
  const targets = resolveTargets(selector);
  if (targets.length === 0) {
    console.error("No databases to read (check .env.local / .env.production). Aborting.");
    process.exit(1);
  }

  const perSource: Record<string, number> = {};
  const all: GoldenCase[] = [];
  for (const t of targets) {
    const cases = await fetchFromTarget(t);
    perSource[t.label] = cases.length;
    all.push(...cases);
  }

  // Dedupe by call_id — keep the most recent correction across environments.
  const byCall = new Map<string, GoldenCase>();
  for (const c of all) {
    const existing = byCall.get(c.callId);
    if (!existing || c.createdAt > existing.createdAt) byCall.set(c.callId, c);
  }
  const merged = [...byCall.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  await writeGolden(merged);

  const summary = targets.map((t) => `${t.label}: ${perSource[t.label] ?? 0}`).join(" · ");
  console.log(`${summary} · merged unique: ${merged.length}`);
  console.log(`Wrote ${merged.length} golden case(s) → ${GOLDEN_PATH}`);
  if (merged.length === 0) {
    console.log("(No corrections yet — submit some from the transcript drawer.)");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
