// Import the Campaign_Call_Review Google Sheet into intent_score_feedback.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// src/lib/google/sheet.ts appends one row per AI call to a Campaign_Call_Review
// tab, with a blank column per named reviewer (CALL_REVIEWERS: Sonu, Kartik,
// Sanchit, Abhishek, Apoorv, Nidhi, Sweeti). Nothing in the repository has ever
// read that tab back. Seven people have been filing call feedback into a
// write-only sink — which is precisely why docs/ai intent/eval/report.json
// still reports total: 2, accuracy: 0 while real review work was happening
// every week.
//
// This script is the one-time bridge: it reads that tab and turns each non-empty
// reviewer cell into an intent_score_feedback row, so the team's accumulated
// judgement becomes the starting golden set instead of being thrown away when
// the sheet is switched off.
//
// ── WHAT IT WILL AND WILL NOT CLAIM ──────────────────────────────────────────
// The reviewer columns are FREE TEXT. Some cells name a band ("cold, he just
// said haan once"); many are prose with no verdict in them at all. Inventing a
// label for the second kind would poison the golden set with fabricated ground
// truth — the model would be trained against opinions nobody expressed.
//
// So each cell lands as one of two things:
//   review_kind = 'correction'  a band was parsed from the text. Real ground
//                               truth, eligible for the golden set and the
//                               accuracy number.
//   review_kind = 'note'        no band found. Preserved verbatim as
//                               reviewer_note so the observation is not lost,
//                               but excluded from every consumer that treats a
//                               row as a label.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
// Imported rows are NEVER applied to leads (applied_to_lead stays false). This
// is months-old commentary about calls whose leads have since been contacted,
// converted or lost; replaying it onto live records would rewrite the current
// pipeline from an archive. It is training data, not instructions.
//
// ── USAGE ────────────────────────────────────────────────────────────────────
//   npm run intent:import-sheet                  dry run (default) — prints
//                                                what it WOULD import
//   npm run intent:import-sheet -- --apply       actually write
//   npm run intent:import-sheet -- --db=prod     target production instead of
//                                                sandbox (default: sandbox)
//
// Re-running is safe: every row carries an external_key and the insert is an
// ON CONFLICT DO NOTHING against a partial unique index.

import dotenv from "dotenv";
import { makeClient, resolveTargets } from "./_lib";
import { parseBandFromReview, type Band } from "./reviewTextParser";

dotenv.config({ path: ".env.local" });

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const dbArg = (args.find((a) => a.startsWith("--db=")) ?? "--db=sandbox").split("=")[1];

const BAND_TO_STATUS: Record<Band, string> = {
  Qualified: "qualified",
  Warm: "warm",
  Cold: "cold",
  Disqualified: "disqualified",
};

async function main() {
  const targets = resolveTargets(dbArg === "prod" ? "prod" : "sandbox");
  if (targets.length === 0) {
    console.error("No database target resolved. Check .env.local / .env.production.");
    process.exit(1);
  }
  const target = targets[0];

  if (!process.env.GOOGLE_SHEET_ID) {
    console.error("GOOGLE_SHEET_ID is not set — nothing to read.");
    process.exit(1);
  }

  console.log(
    `\nReading Campaign_Call_Review → ${target.label} (${APPLY ? "APPLY" : "DRY RUN"})\n`,
  );

  // Imported lazily so a missing googleapis credential fails here with a clear
  // message rather than at module load.
  const { readCallReviews } = await import("@/lib/google/sheet");
  const rows = await readCallReviews();

  console.log(`${rows.length} sheet row(s) carry at least one reviewer comment.`);

  const sql = makeClient(target.url);
  let corrections = 0;
  let notes = 0;
  let skippedNoCall = 0;
  let inserted = 0;

  try {
    for (const row of rows) {
      // The sheet's UUID column is the provider call id (ai_call_logs.call_id).
      // Without a matching call there is nothing to attribute the feedback to
      // and no AI band to compare against, so the row would be a note about
      // nothing.
      const call = await sql`
        SELECT call_id, lead_id, band, intent_score, signals, scoring_version
          FROM ai_call_logs
         WHERE call_id = ${row.uuid}
         ORDER BY created_at DESC
         LIMIT 1
      `;
      if (call.length === 0) {
        skippedNoCall += row.feedback.length;
        continue;
      }
      const c = call[0];

      for (const fb of row.feedback) {
        const band = parseBandFromReview(fb.text);
        const kind = band ? "correction" : "note";
        if (band) corrections += 1;
        else notes += 1;

        // 'none' is a sentinel for a note: corrected_status is NOT NULL (E-159)
        // but a note asserts no band. Every consumer filters on review_kind, so
        // the sentinel is never read as a label.
        const status = band ? BAND_TO_STATUS[band] : "none";
        const agreed = band && c.band ? c.band === band : null;
        const externalKey = `sheet:${row.uuid}:${fb.reviewer}`;

        if (!APPLY) {
          console.log(
            `  ${kind.padEnd(10)} ${row.uuid.slice(0, 12)}… ${fb.reviewer.padEnd(9)} ` +
              `${(band ?? "—").padEnd(13)} ${fb.text.slice(0, 60).replace(/\s+/g, " ")}`,
          );
          continue;
        }

        // ⚠ The ON CONFLICT target MUST repeat the partial index's predicate
        // (E-250 created it as `... WHERE external_key IS NOT NULL`). Without
        // the WHERE, Postgres cannot match the index and the statement fails
        // with "no unique or exclusion constraint matching the ON CONFLICT
        // specification".
        const res = await sql`
          INSERT INTO intent_score_feedback
            (call_id, lead_id, scoring_version, original_intent_score,
             original_signals, ai_band, corrected_status, reviewer_note,
             reviewer_role, review_kind, source, external_key, agreed,
             applied_to_lead)
          VALUES
            (${c.call_id}, ${c.lead_id}, ${c.scoring_version}, ${c.intent_score},
             ${c.signals as never}, ${c.band}, ${status},
             ${`${fb.reviewer} (Google Sheet): ${fb.text}`},
             'sheet_reviewer', ${kind}, 'sheet_import', ${externalKey}, ${agreed},
             false)
          ON CONFLICT (external_key) WHERE external_key IS NOT NULL DO NOTHING
          RETURNING id
        `;
        if (res.length > 0) inserted += 1;
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  console.log(`
Summary (${APPLY ? "written" : "dry run — nothing written"})
  corrections (band parsed)     ${corrections}
  notes       (no band found)   ${notes}
  skipped     (no matching call) ${skippedNoCall}
${APPLY ? `  rows inserted                 ${inserted} (re-runs are no-ops)` : ""}

${
  APPLY
    ? "Next: npm run intent:export-golden && npm run eval:intent"
    : "Re-run with --apply to write these rows."
}
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
