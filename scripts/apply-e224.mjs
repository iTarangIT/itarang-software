// Applies drizzle/E-224_neodove_integration.sql to whatever DATABASE_URL
// points at in .env.local. Idempotent — safe to re-run. Run with:
//   node scripts/apply-e224.mjs
//
// Without this, /api/campaigns/unified can only show AI-dialer campaigns: the
// route probes for the neodove_* tables and omits its NeoDove CTE when they are
// absent, because a missing relation fails a statement at PARSE time and would
// otherwise take the whole Campaigns tab down with it.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const url = env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, "");
const ddl = readFileSync("drizzle/E-224_neodove_integration.sql", "utf8");

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  console.log("HOST:", new URL(url).hostname);
  await sql.unsafe(ddl);

  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('neodove_campaigns', 'neodove_lead_links', 'neodove_sync_events')
    ORDER BY table_name`;
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'dealer_leads' AND column_name LIKE 'neodove%'
    ORDER BY column_name`;
  // The three uniqueness guarantees the integration actually leans on: campaign
  // re-push idempotency, the NeoDove-lead-id link, and inbound webhook dedupe.
  const idx = await sql`
    SELECT indexname FROM pg_indexes
    WHERE indexname IN ('neodove_lead_links_lead_campaign_key',
                        'neodove_lead_links_neodove_lead_key',
                        'neodove_sync_events_inbound_key')
    ORDER BY indexname`;

  const ok = tables.length === 3 && cols.length === 2 && idx.length === 3;
  console.log("tables:", tables.map((r) => r.table_name).join(", ") || "(none)");
  console.log("dealer_leads columns:", cols.map((r) => r.column_name).join(", ") || "(none)");
  console.log("unique indexes:", idx.map((r) => r.indexname).join(", ") || "(none)");
  console.log(
    ok
      ? "OK — E-224 applied. Reload /leads → Campaigns; NeoDove campaigns now appear alongside AI-dialer ones."
      : `FAILED — expected 3 tables / 2 columns / 3 unique indexes, got ${tables.length} / ${cols.length} / ${idx.length}.`,
  );
} finally {
  await sql.end();
}
