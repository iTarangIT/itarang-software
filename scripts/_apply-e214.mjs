// Apply E-214 (internal WhatsApp onboarding operators) to the connected host.
//
// Symptom without it:
//   relation "whatsapp_operators" does not exist   (42P01)
// on GET/POST /api/admin/whatsapp-operators, and — more seriously — on every
// inbound WhatsApp message, because getOrCreateSession() now selects
// whatsapp_onboarding_sessions.session_kind.
//
// E-214 is strictly additive + idempotent (CREATE TABLE/INDEX IF NOT EXISTS,
// ADD COLUMN IF NOT EXISTS), so re-running is a no-op. Run with:
//   node scripts/_apply-e214.mjs
//
// NOTE: DATABASE_URL flips between the two AWS hosts (database-1 / database-2),
// which have drifted, so a migration on one is absent on the other. Both must
// get E-214. Pass a host filter to target the one that ISN'T currently active
// without editing .env.local — the inactive host's URL is usually sitting there
// commented out:
//   node scripts/_apply-e214.mjs               # whatever DATABASE_URL is live
//   node scripts/_apply-e214.mjs database-1    # the other one
import { readFileSync } from "node:fs";
import postgres from "postgres";

const hostOf = (u) => (u.match(/@([^:/]+)/) || [])[1];
const clean = (v) => v.trim().replace(/^["']|["']$/g, "");

const want = (process.argv[2] || "").trim();
const env = readFileSync(".env.local", "utf8");

// The live URL, plus every commented-out one — the host we want is usually the
// one that was commented when the app was pointed at the other.
const active = [...env.matchAll(/^\s*DATABASE_URL\s*=\s*(.+)$/gm)]
  .map((m) => clean(m[1]))
  .filter((u) => u.startsWith("postgres"));
const commented = [...env.matchAll(/^\s*#\s*DATABASE_URL\s*=\s*(.+)$/gm)]
  .map((m) => clean(m[1]))
  .filter((u) => u.startsWith("postgres"));
const all = [...active, ...commented];

if (all.length === 0) {
  console.error("No DATABASE_URL found in .env.local");
  process.exit(1);
}

const url = want ? all.find((u) => u.includes(want)) : active[0];
if (!url) {
  console.error(
    want
      ? `No DATABASE_URL in .env.local matching "${want}". Hosts found:`
      : "No uncommented DATABASE_URL in .env.local. Hosts found:",
  );
  for (const u of all) console.error("  -", hostOf(u));
  process.exit(1);
}

console.log("Applying E-214 to host:", hostOf(url));

const e214 = readFileSync(
  "drizzle/E-214_whatsapp_onboarding_operators.sql",
  "utf8",
);

const sql = postgres(url, {
  ssl: "require",
  prepare: false,
  max: 1,
  connect_timeout: 15,
});
try {
  await sql.unsafe(e214);
  console.log("E-214 applied OK\n");

  const tbl = await sql`SELECT to_regclass('public.whatsapp_operators') AS t`;
  console.log(
    "whatsapp_operators table:            ",
    tbl[0].t ? "present" : "MISSING (unexpected)",
  );

  const sessionCols = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'whatsapp_onboarding_sessions'
      AND column_name IN ('session_kind', 'operator_id', 'parent_session_id')
    ORDER BY column_name`;
  console.log(
    "whatsapp_onboarding_sessions columns:",
    sessionCols.length === 3
      ? "all 3 present"
      : `only ${sessionCols.map((c) => c.column_name).join(", ") || "none"}`,
  );

  const appCols = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'dealer_onboarding_applications'
      AND column_name IN (
        'onboarding_operator_id', 'onboarding_channel',
        'wa_operator_session_id', 'operator_invited_at', 'operator_handoff_at')
    ORDER BY column_name`;
  console.log(
    "dealer_onboarding_applications cols: ",
    appCols.length === 5
      ? "all 5 present"
      : `only ${appCols.map((c) => c.column_name).join(", ") || "none"}`,
  );

  const hubIdx = await sql`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'whatsapp_onboarding_sessions'
      AND indexname = 'whatsapp_onboarding_sessions_operator_hub_key'`;
  console.log(
    "operator_hub partial UNIQUE index:   ",
    hubIdx.length ? "present" : "MISSING (unexpected)",
  );

  // Every pre-E-214 row must read as an ordinary dealer session, or the
  // existing single-dealer flow would change behaviour.
  const kinds = await sql`
    SELECT session_kind, count(*)::int AS n
    FROM whatsapp_onboarding_sessions
    GROUP BY session_kind ORDER BY n DESC`;
  console.log(
    "\nexisting sessions by kind:",
    kinds.map((k) => `${k.session_kind}=${k.n}`).join(", ") || "(none)",
  );
} finally {
  await sql.end();
}
