// The transcription queue: claim an attached recording, turn it into text, and
// score it through the same engine the AI dialer uses.
//
// ── WHY THE RECORDINGS TABLE IS ITS OWN QUEUE ────────────────────────────────
// E-241 gave the scraper a separate scraper_job_queue because the work item —
// a (query, city) pair — had no row of its own to hang state off. Here it does:
// one uploaded recording IS one transcription job, one-to-one, permanently. A
// second table would be a join with no cardinality behind it, plus a second
// place for the two halves to disagree about what state a recording is in.
//
// ── WHY NOT BullMQ ───────────────────────────────────────────────────────────
// It is dead code in this repository and the verdict is already written down in
// src/instrumentation-node.ts: production declares no worker process, the
// sandbox worker is deliberately dormant, callQueue.add() is never called
// anywhere, and Vercel crons do not fire on the pm2 VPS. An in-process ticker
// is the only mechanism that demonstrably runs in BOTH environments.
//
// ── WHY EVERY TIMESTAMP IS COMPUTED IN SQL ───────────────────────────────────
// Two independent reasons, both learned the hard way in this codebase:
//   1. pm2 VPS clocks drift (src/lib/nbfc/auction/scheduler.ts records what an
//      app-clock comparison cost when they did).
//   2. A JS Date interpolated into a raw drizzle sql`` template throws
//      ERR_INVALID_ARG_TYPE at runtime — not at build, at runtime, on the first
//      real row.
// So: now(), and intervals added in SQL. Never a JS Date.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { analyzeTranscript } from "@/lib/ai/analysis";
import { getObject } from "@/lib/storage/s3";
import { RECORDINGS_BUCKET } from "./audioUpload";
import { transcribeAudio } from "./transcribeAudio";

/** How many recordings one tick will process. */
const BATCH = 2;

/**
 * Give up after this many attempts.
 *
 * Low on purpose. A recording that has failed transiently three times is not
 * about to succeed on the fourth — it is far more likely to be a file the
 * transcriber genuinely cannot read, and every further retry spends real money
 * re-uploading 25 MB to OpenAI while the reviewer stares at a spinner. Failing
 * fast and showing them the reason is more useful than retrying forever.
 */
const MAX_ATTEMPTS = 3;

interface ClaimedRecording {
  id: string;
  lead_id: string;
  call_id: string | null;
  purpose: string;
  s3_key: string;
  content_type: string | null;
  original_filename: string | null;
  attempts: number;
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) || [];
}

/**
 * Claim up to `BATCH` pending recordings in ONE statement.
 *
 * FOR UPDATE SKIP LOCKED is the real cross-process guard. The ticker's
 * in-process `inFlight` flag only covers this node; sandbox and production are
 * separate processes and a future second instance would race here. The loser
 * skips the locked row and takes the next one instead of duplicating work.
 *
 * `attempts` is incremented INSIDE the claim, before the work runs — so a job
 * that hard-crashes the transcriber still burns an attempt and eventually stops
 * being claimed, rather than wedging the queue in a crash loop.
 */
async function claimBatch(): Promise<ClaimedRecording[]> {
  const result = await db.execute(sql`
    UPDATE lead_call_recordings
       SET status     = 'running',
           claimed_at = now(),
           attempts   = attempts + 1
     WHERE id IN (
       SELECT id
         FROM lead_call_recordings
        WHERE status = 'pending'
          AND next_attempt_at <= now()
        ORDER BY next_attempt_at
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, lead_id, call_id, purpose, s3_key,
              content_type, original_filename, attempts
  `);
  return rowsOf<ClaimedRecording>(result);
}

/**
 * Mark a claimed row failed — permanently, or scheduled for another go.
 *
 * The backoff is exponential in SQL (`now() + interval * 2^attempts`) so a
 * provider having a bad minute is not hammered every 30 seconds.
 */
async function fail(
  id: string,
  reason: string,
  retryable: boolean,
  attempts: number,
): Promise<void> {
  const exhausted = !retryable || attempts >= MAX_ATTEMPTS;

  if (exhausted) {
    await db.execute(sql`
      UPDATE lead_call_recordings
         SET status = 'failed', error = ${reason}
       WHERE id = ${id}::uuid
    `);
    return;
  }

  await db.execute(sql`
    UPDATE lead_call_recordings
       SET status          = 'pending',
           error           = ${reason},
           next_attempt_at = now() + (interval '2 minutes' * ${attempts})
     WHERE id = ${id}::uuid
  `);
}

/**
 * Process one claimed recording: fetch bytes → transcribe → extract → band.
 *
 * The analysis half is deliberately the EXACT pipeline an AI call goes through
 * (analyzeTranscript → extractSignals → computeBand). A human follow-up call
 * and a dialer call must be graded by the same rules, or the whole point of
 * attaching audio — "let the AI understand this conversation too" — collapses
 * into a second, differently-calibrated scoring path.
 *
 * Note what this does NOT do: it never touches the lead. The recording gets its
 * own band and the reviewer decides whether to accept it by submitting a
 * correction. Audio a colleague uploaded should not silently re-route someone
 * else's pipeline.
 */
async function processOne(rec: ClaimedRecording): Promise<void> {
  const audio = await getObject(RECORDINGS_BUCKET, rec.s3_key);
  if (!audio) {
    // The row points at bytes that are not there. No amount of retrying fixes
    // a missing object.
    await fail(rec.id, "The stored audio could not be read back.", false, rec.attempts);
    return;
  }

  const transcription = await transcribeAudio(
    audio,
    rec.original_filename || `${rec.id}.audio`,
    rec.content_type || "audio/mpeg",
  );

  if (transcription.status === "failed") {
    await fail(rec.id, transcription.reason, transcription.retryable, rec.attempts);
    return;
  }

  const analysis = await analyzeTranscript(transcription.text);

  // A transcript we could not score is still worth keeping — the reviewer can
  // read it, and it is the expensive half. Store it and record why the scoring
  // half did not land, rather than throwing the whole job away.
  if (analysis.status !== "ok") {
    await db.execute(sql`
      UPDATE lead_call_recordings
         SET status           = 'done',
             transcript       = ${transcription.text},
             transcript_segments = ${
               transcription.segments
                 ? sql`${JSON.stringify(transcription.segments)}::jsonb`
                 : sql`NULL`
             },
             language         = ${transcription.language},
             transcribe_model = ${transcription.model},
             error            = ${`Transcribed, but scoring failed: ${
               (analysis as { reason?: string }).reason ?? "unknown"
             }`},
             transcribed_at   = now()
       WHERE id = ${rec.id}::uuid
    `);
    return;
  }

  // The one-line neutral summary is a field the EXTRACTOR fills, not something
  // the band engine derives — it lives on signals, not on the analysis root.
  const summary = analysis.signals.call_summary || null;

  await db.execute(sql`
    UPDATE lead_call_recordings
       SET status              = 'done',
           transcript          = ${transcription.text},
           transcript_segments = ${
             transcription.segments
               ? sql`${JSON.stringify(transcription.segments)}::jsonb`
               : sql`NULL`
           },
           language            = ${transcription.language},
           transcribe_model    = ${transcription.model},
           signals             = ${sql`${JSON.stringify(analysis.signals)}::jsonb`},
           score_breakdown     = ${sql`${JSON.stringify(analysis.score_breakdown)}::jsonb`},
           band                = ${analysis.band},
           intent_score        = ${analysis.intent_score},
           info_signals_count  = ${analysis.info_signals_count},
           call_summary        = ${summary},
           scoring_version     = ${analysis.scoring_version},
           extraction_version  = ${analysis.extraction_version ?? null},
           error               = NULL,
           transcribed_at      = now()
     WHERE id = ${rec.id}::uuid
  `);
}

/**
 * One tick. Claims a batch and processes it, isolating each recording so one
 * bad file cannot take the rest of the batch down with it.
 */
export async function runTranscriptionTick(): Promise<number> {
  const claimed = await claimBatch();
  if (claimed.length === 0) return 0;

  for (const rec of claimed) {
    try {
      await processOne(rec);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // An unexpected throw is treated as retryable: it is far more likely to
      // be a transient network or S3 blip than a property of the file, and
      // MAX_ATTEMPTS still bounds it.
      await fail(rec.id, message, true, rec.attempts).catch(() => {
        /* the row stays 'running' and the reaper below will free it */
      });
    }
  }

  return claimed.length;
}

/**
 * Free rows whose process died mid-transcription.
 *
 * Without this a pm2 restart during a claim leaves the row stuck in 'running'
 * forever — invisible to the claim query, and showing the reviewer a spinner
 * that will never resolve. Ten minutes is comfortably longer than the slowest
 * legitimate 25 MB transcription.
 */
export async function reapStuckRecordings(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE lead_call_recordings
       SET status          = 'pending',
           next_attempt_at = now(),
           error           = 'Transcription was interrupted; retrying.'
     WHERE status = 'running'
       AND claimed_at < now() - interval '10 minutes'
    RETURNING id
  `);
  return rowsOf<{ id: string }>(result).length;
}
