import "dotenv/config";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url, {
  ssl: { rejectUnauthorized: false },
  max: 1,
});

async function main() {
  console.log("Applying scraper chunks migration...");

  await sql`
    ALTER TABLE scraper_runs
      ADD COLUMN IF NOT EXISTS total_chunks integer DEFAULT 0,
      ADD COLUMN IF NOT EXISTS completed_chunks integer DEFAULT 0
  `;
  console.log("✓ scraper_runs columns added");

  await sql`
    CREATE TABLE IF NOT EXISTS scraper_run_chunks (
      id text PRIMARY KEY,
      run_id text NOT NULL,
      combination_query text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      leads_count integer DEFAULT 0,
      error_message text,
      created_at timestamp DEFAULT now(),
      completed_at timestamp
    )
  `;
  console.log("✓ scraper_run_chunks table created");

  await sql`
    CREATE INDEX IF NOT EXISTS scraper_run_chunks_run_id_idx
      ON scraper_run_chunks (run_id)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS scraper_run_chunks_status_idx
      ON scraper_run_chunks (status)
  `;
  console.log("✓ indexes created");

  await sql.end();
  console.log("Migration complete.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
