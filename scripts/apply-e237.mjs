// Applies drizzle/E-237_neodove_crm_assignment.sql to whatever DATABASE_URL
// points at in .env.local. Idempotent — safe to re-run:
//   node scripts/apply-e237.mjs
//
// What breaks without it, and how loudly:
//
//   neodove_campaigns.crm_owner_user_id — the campaign form's "assign pushed
//   leads to" field and the push modal's pre-filled assignee. Every READ goes
//   through to_jsonb, so an unapplied E-237 degrades to "no campaign default
//   ever resolves" rather than a 500; but SAVING a CRM owner on a campaign
//   names the column and would fail at PARSE time, so the field must not be
//   offered until this lands.
//
//   neodove_lead_links.assigned_owner_id / assigned_at — per-push bookkeeping.
//   Nothing 500s without them: assignAfterPush stamps them in a nested
//   try/catch, so a missing column costs the audit stamp and never the
//   assignment. That makes this half silent data loss rather than an outage —
//   which is exactly why it is verified here instead of via a bug report.
//
// On a DB with no neodove_* tables at all (prod today, pre-E-224) both halves
// are guarded no-ops and report as skipped rather than failed.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const url = env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, "");
const ddl = readFileSync("drizzle/E-237_neodove_crm_assignment.sql", "utf8");

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  console.log("HOST:", new URL(url).hostname);
  await sql.unsafe(ddl);

  const camp = await sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'neodove_campaigns'
       AND column_name = 'crm_owner_user_id'`;

  const links = await sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'neodove_lead_links'
       AND column_name IN ('assigned_owner_id', 'assigned_at')`;

  const idx = await sql`
    SELECT indexname FROM pg_indexes
     WHERE indexname = 'neodove_lead_links_assigned_owner_idx'`;

  const hasNeodove = await sql`SELECT to_regclass('neodove_campaigns') AS t`;
  const skipped = hasNeodove[0].t === null;

  const campOk = camp.length === 1;
  const linksOk = links.length === 2 && idx.length === 1;

  console.log(
    skipped
      ? "SKIPPED — neodove_campaigns does not exist on this DB (E-224 not applied). CRM co-assignment is unavailable here until it is; nothing else is affected."
      : campOk
        ? "OK — neodove_campaigns.crm_owner_user_id present; a campaign can now carry a default CRM owner."
        : `FAILED — expected crm_owner_user_id, got ${JSON.stringify(camp.map((r) => r.column_name))}.`,
  );
  console.log(
    skipped
      ? "SKIPPED — neodove_lead_links absent for the same reason."
      : linksOk
        ? "OK — neodove_lead_links.assigned_owner_id + .assigned_at present with their partial index; per-push assignment history will be recorded."
        : `FAILED — columns ${JSON.stringify(links.map((r) => r.column_name))}, index ${JSON.stringify(idx.map((r) => r.indexname))}.`,
  );
} finally {
  await sql.end();
}
