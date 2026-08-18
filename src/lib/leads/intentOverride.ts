// Applying a human intent correction TO THE LEAD — the write-through half of
// the review loop.
//
// E-159 recorded corrections and stopped there: the row landed in
// intent_score_feedback, a "Corrected" pill lit up, and the lead carried on
// routing on the AI's band in every queue, filter and dashboard. A reviewer
// could tell the system it was wrong an unlimited number of times and nothing
// would move. E-250 makes the correction an OVERRIDE, and this module is where
// that happens.
//
// ── WHY RAW SQL AND NOT THE DRIZZLE QUERY BUILDER ────────────────────────────
// The three provenance columns (intent_band_source, intent_overridden_by,
// intent_overridden_at) are deliberately NOT declared on the `dealerLeads`
// drizzle object — see the long comment at their position in
// src/lib/db/schema.ts. Drizzle names EVERY column of a table object in its
// generated SQL, so declaring them there would hard-fail every bare
// `db.select().from(dealerLeads)` — the leads list, the AI dialer, the CEO
// overview, ~20 call sites — at parse time on any database where E-250 has not
// been applied yet. The DBs demonstrably drift (drizzle/MIGRATION_CHECKLIST.md
// opens by saying so), and taking the leads screen down to add a provenance
// label is not a trade worth making.
//
// Writing them through a raw `sql` projection instead confines an unapplied
// E-250 to THIS feature: the override 500s, the reviewer sees an error, and
// everything else in the CRM keeps working.
//
// ── WHY THE UPDATE IS ONE STATEMENT ──────────────────────────────────────────
// The band, the score, the status, the interest level and the provenance must
// move together or not at all. A lead showing intent_band='Warm' next to
// final_intent_score=90 is worse than one showing the AI's wrong answer,
// because every numeric filter and every band filter would disagree about the
// same row.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  bandOutcome,
  bandToStatus,
  type Band,
} from "@/lib/ai/scoring";

/** The four bands a reviewer can pick, as the UI spells them (lowercase). */
export const REVIEW_STATUSES = [
  "qualified",
  "warm",
  "cold",
  "disqualified",
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface ApplyOverrideInput {
  leadId: string;
  band: Band;
  /**
   * The reviewer's explicit number, when they typed one. Almost always null:
   * the band's canonical lead_score is the right answer and is what every
   * threshold downstream was tuned against. Honoured when present because a
   * reviewer who deliberately types 55 is saying something the four buttons
   * cannot.
   */
  score?: number | null;
  reviewerId: string;
}

export interface ApplyOverrideResult {
  applied: boolean;
  band: Band;
  score: number;
  status: string | null;
  interestLevel: string | null;
  /** Set when the write was skipped rather than failed — see `applied`. */
  reason?: string;
}

/**
 * Write a human-corrected band through to the lead.
 *
 * Deliberately NOT wrapped in a transaction with the feedback insert. The
 * feedback row is the durable record and must survive even if this fails — a
 * correction that trains the model but loses the race to update the lead is a
 * recoverable annoyance; a lost correction is destroyed evidence. The caller
 * marks `applied_to_lead` from the result.
 */
export async function applyIntentOverride(
  input: ApplyOverrideInput,
): Promise<ApplyOverrideResult> {
  const { leadId, band, reviewerId } = input;

  const outcome = bandOutcome(band);
  const status = bandToStatus(band);

  // A reviewer's explicit score wins over the band's canonical one, clamped to
  // the 0-100 the column and every threshold assume.
  const score =
    input.score == null
      ? outcome.lead_score
      : Math.max(0, Math.min(100, Math.trunc(input.score)));

  const result = await db.execute(sql`
    UPDATE dealer_leads
       SET intent_band          = ${band},
           final_intent_score   = ${score},
           current_status       = ${status},
           interest_level       = ${outcome.interest_level},
           intent_band_source   = 'human',
           intent_overridden_by = ${reviewerId}::uuid,
           -- now() in SQL, never a JS Date: a JS Date interpolated into a raw
           -- drizzle template throws ERR_INVALID_ARG_TYPE at runtime, and the
           -- pm2 VPS clock drifts besides.
           intent_overridden_at = now()
     WHERE id = ${leadId}
    RETURNING id
  `);

  const rows = (result as { rows?: unknown[] }).rows ?? (result as unknown[]);
  const applied = Array.isArray(rows) && rows.length > 0;

  return {
    applied,
    band,
    score,
    status,
    interestLevel: outcome.interest_level,
    reason: applied ? undefined : "lead_not_found",
  };
}

/**
 * Record the human band on the CALL, alongside — never over — the AI's.
 *
 * ⚠ `ai_call_logs.band` and `.intent_score` are left untouched on purpose. That
 * row is the AI's own output and the eval harness (scripts/intent) replays it
 * to measure how often the model agreed with a human. Overwriting band with the
 * human answer would feed the correction back in as if the AI had produced it,
 * and every corrected call would score as a perfect hit — the measurement would
 * consume its own evidence and report 100% accuracy forever.
 */
export async function stampHumanBandOnCall(
  callId: string,
  band: Band,
  reviewerId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE ai_call_logs
       SET human_band        = ${band},
           human_reviewed_by = ${reviewerId}::uuid,
           human_reviewed_at = now()
     WHERE call_id = ${callId}
  `);
}

/**
 * Read the provenance of a lead's current band, for the UI label.
 *
 * Returns `source: 'ai'` when E-250 has not been applied — the column is simply
 * absent, which is indistinguishable from "nobody has overridden this lead" as
 * far as the panel is concerned, and is the honest default either way.
 */
export async function readIntentProvenance(leadId: string): Promise<{
  source: "ai" | "human";
  overriddenBy: string | null;
  overriddenByName: string | null;
  overriddenAt: string | null;
}> {
  const fallback = {
    source: "ai" as const,
    overriddenBy: null,
    overriddenByName: null,
    overriddenAt: null,
  };

  try {
    const result = await db.execute(sql`
      SELECT dl.intent_band_source              AS source,
             dl.intent_overridden_by::text      AS overridden_by,
             u.name                             AS overridden_by_name,
             dl.intent_overridden_at            AS overridden_at
        FROM dealer_leads dl
        LEFT JOIN users u ON u.id = dl.intent_overridden_by
       WHERE dl.id = ${leadId}
       LIMIT 1
    `);

    const rows =
      ((result as { rows?: Record<string, unknown>[] }).rows ??
        (result as Record<string, unknown>[])) || [];
    const row = rows[0];
    if (!row) return fallback;

    const at = row.overridden_at;
    return {
      source: row.source === "human" ? "human" : "ai",
      overriddenBy: (row.overridden_by as string | null) ?? null,
      overriddenByName: (row.overridden_by_name as string | null) ?? null,
      overriddenAt:
        at instanceof Date ? at.toISOString() : ((at as string | null) ?? null),
    };
  } catch {
    // undefined_column (42703) when E-250 is unapplied. The panel degrades to
    // "this is the AI's band", which is what it showed before this feature.
    return fallback;
  }
}
