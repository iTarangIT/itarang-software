// E-241 — proves every SQL statement src/lib/scraper/jobQueue.ts issues, against
// the REAL database, WITHOUT needing the migration applied: it builds a TEMP
// table matching the E-241 DDL inside a transaction that always rolls back.
//
//   node --env-file=.env.local scripts/verify-e241-queue-sql.mjs
//
// Worth having because the queue's behaviour lives in SQL, not TypeScript —
// tsc cannot tell you that a jsonb aggregate has no min(), that @> matches an
// array ELEMENT, or that ORDER BY put its two columns the wrong way round. That
// last one was a real bug this script caught before the migration was applied
// anywhere: leading with seq sorts ACROSS batches (seq restarts at 0 per
// submission), so concurrent batches round-robin instead of draining FIFO.
//
// Checks: window eligibility (now/once/daily incl. weekday filter), the claim
// statement, claim exclusivity + FIFO ordering, reconcileFinishedJobs(), the
// orphan sweep, and the listBatches() aggregate.
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, {
  ssl: "require", prepare: false, max: 2, connect_timeout: 20, idle_timeout: 5,
});

let failed = 0;
const ok = (name) => console.log(`  PASS  ${name}`);
const bad = (name, e) => { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); };

await sql.begin(async (tx) => {
  // Mirror of the E-241 DDL, as a TEMP table so nothing touches the real DB.
  await tx.unsafe(`
    CREATE TEMP TABLE scraper_job_queue (
      id text PRIMARY KEY, batch_id text NOT NULL, seq integer NOT NULL DEFAULT 0,
      query_text text NOT NULL, city text, max_results integer,
      expand_with_ai boolean NOT NULL DEFAULT false,
      status varchar(16) NOT NULL DEFAULT 'queued', run_id varchar(255),
      attempts integer NOT NULL DEFAULT 0, last_error text,
      schedule_mode varchar(16) NOT NULL DEFAULT 'now', run_after timestamptz,
      window_start varchar(5), window_end varchar(5), window_days jsonb,
      created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
      dispatched_at timestamptz, finished_at timestamptz,
      leads_promoted integer NOT NULL DEFAULT 0
    ) ON COMMIT DROP`);

  // One INSERT per batch, with an explicitly staggered created_at. This is what
  // production looks like: enqueueBatch() runs one statement per submission
  // outside any explicit transaction, so each batch gets its own now(). Putting
  // them all in ONE statement (as the first draft of this probe did) gives every
  // row an IDENTICAL created_at, which collapses the FIFO tie-break onto seq and
  // makes the claim look like it round-robins when it does not.
  await tx.unsafe(`
    INSERT INTO scraper_job_queue
      (id, batch_id, seq, query_text, city, schedule_mode, window_start, window_end, window_days, expand_with_ai, created_at)
    VALUES
      ('J1','B1',0,'lithium battery','prayagraj','now',NULL,NULL,NULL,false, now() - interval '30 min'),
      ('J2','B1',1,'lithium battery','lucknow','now',NULL,NULL,NULL,false,   now() - interval '30 min'),
      ('J3','B2',0,'sukhi battery',NULL,'daily','00:00','23:59',NULL,true,   now() - interval '20 min'),
      ('J4','B3',0,'port battery','kanpur','daily','03:00','04:00','["mon"]'::jsonb,false, now() - interval '10 min'),
      ('J5','B4',0,'future battery','agra','once',NULL,NULL,NULL,false,      now() - interval '5 min')`);
  await tx.unsafe(`UPDATE scraper_job_queue SET run_after = now() + interval '1 day' WHERE id='J5'`);

  const ELIGIBLE = `(
    schedule_mode = 'now'
    OR (schedule_mode = 'once' AND run_after IS NOT NULL AND run_after <= now())
    OR (
      schedule_mode = 'daily' AND window_start IS NOT NULL AND window_end IS NOT NULL
      AND (window_days IS NULL
           OR window_days @> to_jsonb(lower(to_char(now() AT TIME ZONE 'Asia/Kolkata','dy'))))
      AND CASE WHEN window_end > window_start
                 THEN to_char(now() AT TIME ZONE 'Asia/Kolkata','HH24:MI') >= window_start
                  AND to_char(now() AT TIME ZONE 'Asia/Kolkata','HH24:MI') <  window_end
               ELSE to_char(now() AT TIME ZONE 'Asia/Kolkata','HH24:MI') >= window_start
                 OR to_char(now() AT TIME ZONE 'Asia/Kolkata','HH24:MI') <  window_end
          END))`;

  // 1. Which jobs are eligible right now? Expect J1,J2 (now) and J3 (all-day).
  //    NOT J4 (03:00-04:00 mon only) and NOT J5 (run_after tomorrow).
  try {
    const r = await tx.unsafe(
      `SELECT id FROM scraper_job_queue WHERE status='queued' AND ${ELIGIBLE} ORDER BY id`);
    const got = r.map((x) => x.id).join(",");
    if (got === "J1,J2,J3") ok(`eligibility -> ${got}`);
    else bad("eligibility", new Error(`expected J1,J2,J3 got ${got}`));
  } catch (e) { bad("eligibility", e); }

  // 2. The exact claim statement from dispatchOnce(). Expect J1 (lowest seq).
  try {
    const r = await tx.unsafe(`
      UPDATE scraper_job_queue
         SET status='running', dispatched_at=now(), attempts=attempts+1
       WHERE id = (SELECT id FROM scraper_job_queue
                    WHERE status='queued' AND ${ELIGIBLE}
                    ORDER BY created_at, seq LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, query_text, city, max_results, expand_with_ai, created_by`);
    if (r.length === 1 && r[0].id === "J1") ok(`claim -> ${r[0].id} ("${r[0].query_text}")`);
    else bad("claim", new Error(`expected 1 row J1, got ${JSON.stringify(r.map(x=>x.id))}`));
  } catch (e) { bad("claim", e); }

  // 3. The claim is exclusive: a second claim must take J2, never J1 again.
  try {
    const r = await tx.unsafe(`
      UPDATE scraper_job_queue SET status='running', dispatched_at=now(), attempts=attempts+1
       WHERE id = (SELECT id FROM scraper_job_queue WHERE status='queued' AND ${ELIGIBLE}
                    ORDER BY created_at, seq LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id`);
    if (r[0]?.id === "J2") ok("claim is exclusive AND FIFO (second claim -> J2, same batch, not J3)");
    else bad("claim exclusivity/FIFO", new Error(`expected J2 (batch B1 drains before B2), got ${r[0]?.id}`));
  } catch (e) { bad("claim exclusivity", e); }

  // 4. reconcileFinishedJobs() — needs a real terminal scraper_runs row to join
  //    to, so borrow the newest one that already exists.
  try {
    const [run] = await tx.unsafe(
      `SELECT id, status FROM scraper_runs
        WHERE status IN ('completed','failed','cancelled') ORDER BY started_at DESC LIMIT 1`);
    if (!run) { console.log("  SKIP  reconcile (no terminal scraper_runs row to join)"); }
    else {
      await tx.unsafe(`UPDATE scraper_job_queue SET run_id=$1 WHERE id='J1'`, [run.id]);
      const r = await tx.unsafe(`
        UPDATE scraper_job_queue q
           SET status = CASE r.status WHEN 'completed' THEN 'done'
                                      WHEN 'cancelled' THEN 'cancelled'
                                      ELSE 'failed' END,
               leads_promoted = COALESCE(r.new_leads_promoted, 0),
               last_error = CASE WHEN r.status='completed' THEN q.last_error
                                 ELSE COALESCE(r.error_message, q.last_error) END,
               finished_at = COALESCE(r.completed_at, now())
          FROM scraper_runs r
         WHERE q.run_id = r.id AND q.status='running'
           AND r.status IN ('completed','failed','cancelled')
        RETURNING q.id, q.status`);
      ok(`reconcile -> ${r.length} row(s) settled from run ${run.id} (${run.status})`);
    }
  } catch (e) { bad("reconcile", e); }

  // 5. Orphan sweep — J2 is 'running' with no run_id. Backdate it past the hour.
  try {
    await tx.unsafe(`UPDATE scraper_job_queue SET dispatched_at = now() - interval '2 hours' WHERE id='J2'`);
    const r = await tx.unsafe(`
      UPDATE scraper_job_queue q
         SET status='failed',
             last_error=COALESCE(q.last_error,'dispatch was interrupted before the run was recorded'),
             finished_at=now()
       WHERE q.status='running' AND q.dispatched_at < now() - interval '1 hour'
         AND NOT EXISTS (SELECT 1 FROM scraper_runs r WHERE r.id = q.run_id)
      RETURNING q.id`);
    if (r.length === 1 && r[0].id === "J2") ok("orphan sweep -> J2 released");
    else bad("orphan sweep", new Error(`expected [J2], got ${JSON.stringify(r.map(x=>x.id))}`));
  } catch (e) { bad("orphan sweep", e); }

  // 6. listBatches() aggregate — the one most likely to have a type error.
  try {
    const r = await tx.unsafe(`
      SELECT batch_id,
             count(*)::int AS total,
             count(*) FILTER (WHERE status='queued')::int    AS queued,
             count(*) FILTER (WHERE status='running')::int   AS running,
             count(*) FILTER (WHERE status='done')::int      AS done,
             count(*) FILTER (WHERE status='failed')::int    AS failed,
             count(*) FILTER (WHERE status='cancelled')::int AS cancelled,
             COALESCE(sum(leads_promoted),0)::int            AS leads_promoted,
             bool_or(expand_with_ai)                         AS expand_with_ai,
             min(schedule_mode) AS schedule_mode, min(run_after) AS run_after,
             min(window_start)  AS window_start,  min(window_end) AS window_end,
             (array_agg(window_days) FILTER (WHERE window_days IS NOT NULL))[1] AS window_days,
             min(created_at) AS created_at, min(created_by::text) AS created_by,
             (array_agg(CASE WHEN city IS NULL THEN query_text
                             ELSE query_text||' in '||city END ORDER BY seq))[1] AS sample_query
        FROM scraper_job_queue GROUP BY batch_id ORDER BY min(created_at) DESC LIMIT 20 OFFSET 0`);
    const b4 = r.find((x) => x.batch_id === "B4");
    const b1 = r.find((x) => x.batch_id === "B1");
    if (r.length === 4 && b1?.sample_query === "lithium battery in prayagraj" && b4?.schedule_mode === "once") {
      ok(`listBatches -> ${r.length} batches, sample "${b1.sample_query}"`);
      const b2 = r.find((x) => x.batch_id === "B2");
      console.log(`        B2 window_days=${JSON.stringify(r.find(x=>x.batch_id==="B3").window_days)} expand_with_ai=${b2.expand_with_ai}`);
    } else bad("listBatches", new Error(`unexpected shape: ${JSON.stringify(r.map(x=>[x.batch_id,x.total,x.sample_query]))}`));
  } catch (e) { bad("listBatches", e); }

  throw new Error("__ROLLBACK__");
}).catch((e) => { if (e.message !== "__ROLLBACK__") throw e; });

console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed (transaction rolled back)");
await sql.end();
process.exit(failed ? 1 : 0);
