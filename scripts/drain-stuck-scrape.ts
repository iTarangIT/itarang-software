// Drain any pending chunks for a given run (or the latest run if no
// argument). Useful for recovering scrape runs that got stuck because
// QStash callbacks couldn't reach the dev server (no ngrok tunnel,
// stale QSTASH_CALLBACK_BASE_URL, etc.).
//
// Run as:
//   npx tsx scripts/drain-stuck-scrape.ts                   # latest run
//   npx tsx scripts/drain-stuck-scrape.ts SCRAPE-2026...   # specific run

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const CONCURRENCY = 3;

async function main() {
  const { sql } = await import("drizzle-orm");
  const { db } = await import("../src/lib/db");
  const { executeChunk } = await import("../src/lib/scraper/chunkedPipeline");

  const arg = process.argv[2];
  let runId: string;
  if (arg) {
    runId = arg;
  } else {
    const latest = await db.execute(sql`
      SELECT id FROM scraper_runs ORDER BY created_at DESC LIMIT 1
    `);
    const row = ((latest as any).rows ?? latest)[0];
    if (!row?.id) {
      console.error("no scraper_runs found");
      process.exit(1);
    }
    runId = row.id as string;
  }
  console.log(`[drain] target run: ${runId}`);

  const pendingRes = await db.execute(sql`
    SELECT id FROM scraper_run_chunks
    WHERE run_id = ${runId} AND status IN ('pending', 'running')
    ORDER BY id
  `);
  const pending: { id: string }[] = (pendingRes as any).rows ?? pendingRes;
  console.log(`[drain] ${pending.length} chunks to process`);
  if (!pending.length) {
    console.log("[drain] nothing to do");
    process.exit(0);
  }

  const queue = pending.map((p) => p.id);
  let done = 0;
  while (queue.length) {
    const batch = queue.splice(0, CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((id) => executeChunk(id)),
    );
    results.forEach((r, i) => {
      done += 1;
      if (r.status === "rejected") {
        console.error(`[drain] chunk ${batch[i]} failed:`, r.reason?.message ?? r.reason);
      } else {
        console.log(`[drain] chunk ${batch[i]} done (${done}/${pending.length})`);
      }
    });
  }

  const final = await db.execute(sql`
    SELECT status, COUNT(*)::int AS n
    FROM scraper_run_chunks
    WHERE run_id = ${runId}
    GROUP BY status
  `);
  console.table((final as any).rows ?? final);

  process.exit(0);
}

main().catch((e) => {
  console.error("[drain] ERR:", e?.message ?? e);
  process.exit(1);
});
