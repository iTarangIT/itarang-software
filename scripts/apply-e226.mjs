// Applies drizzle/E-226_neodove_call_recording_and_priority_dial.sql to whatever
// DATABASE_URL points at in .env.local. Idempotent — safe to re-run:
//   node scripts/apply-e226.mjs
//
// Two halves, and they fail differently, so both are verified separately:
//
//   lead_touchpoints.recording_url / external_agent_name — nothing 500s without
//   them. The webhook still writes the touchpoint; the recording URL and the
//   NeoDove agent's name are simply dropped (attachCallEvidence catches and
//   warns). So an unapplied E-226 here is silent data loss, not an outage —
//   which is exactly why it needs checking rather than waiting for a bug report.
//
//   neodove_campaigns.is_priority_dial — the "Call now" button answers "no
//   campaign is set as the priority-dial destination" until this exists, and
//   ticking the box in campaign settings 500s at PARSE time. On a DB with no
//   neodove_* tables at all (prod today, pre-E-224) this half is a guarded
//   no-op and reports as skipped rather than failed.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const url = env.match(/^DATABASE_URL=(.*)$/m)[1].trim().replace(/^["']|["']$/g, "");
const ddl = readFileSync(
  "drizzle/E-226_neodove_call_recording_and_priority_dial.sql",
  "utf8",
);

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  console.log("HOST:", new URL(url).hostname);
  await sql.unsafe(ddl);

  const tp = await sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'lead_touchpoints'
       AND column_name IN ('recording_url', 'external_agent_name')`;

  const camp = await sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'neodove_campaigns'
       AND column_name = 'is_priority_dial'`;

  const idx = await sql`
    SELECT indexname FROM pg_indexes
     WHERE indexname = 'neodove_campaigns_priority_dial_key'`;

  const hasNeodove = await sql`SELECT to_regclass('neodove_campaigns') AS t`;

  const tpOk = tp.length === 2;
  const campOk = camp.length === 1 && idx.length === 1;
  const campSkipped = hasNeodove[0].t === null;

  console.log(
    tpOk
      ? "OK — lead_touchpoints.recording_url + .external_agent_name present; NeoDove call recordings and agent names will now be stored."
      : `FAILED — expected both touchpoint columns, got ${JSON.stringify(tp.map((r) => r.column_name))}.`,
  );
  console.log(
    campSkipped
      ? "SKIPPED — neodove_campaigns does not exist on this DB (E-224 not applied). Priority dial is unavailable here until it is; nothing else is affected."
      : campOk
        ? "OK — neodove_campaigns.is_priority_dial present with its at-most-one unique index; the per-lead Call now action can be pointed at a campaign."
        : `FAILED — column ${JSON.stringify(camp.map((r) => r.column_name))}, index ${JSON.stringify(idx.map((r) => r.indexname))}.`,
  );
} finally {
  await sql.end();
}
