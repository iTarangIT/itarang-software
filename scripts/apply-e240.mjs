// Applies drizzle/E-240_nbfc_dealer_direct_requests.sql. Idempotent — safe to
// re-run:
//   node scripts/apply-e240.mjs
//
// What breaks without it, and how loudly:
//
//   LOUDLY, and on two screens rather than one. nbfc_doc_requests IS mirrored in
//   schema.ts and listThreadForLead() does a bare
//   db.select().from(nbfcDocRequests). Drizzle names every column of a mirrored
//   table in its generated SQL, so on a database without this file BOTH the NBFC
//   Acquire request thread and the admin "NBFC KYC Verification" card fail on
//   their first read with `column "dealer_direct" does not exist`. There is no
//   degraded mode; apply it before deploying the code.
//
// Verified below rather than trusted: the dealer_direct column on the E-200
// wrapper, the messages table's shape, and both of its indexes. The
// (request_id, created_at) index is the one worth asserting — the thread is read
// per-wrapper and ordered by time on every poll of both portals, so its absence
// is a seq-scan per request that no test will fail on.
//
// TARGET SELECTION. By default this reads the ACTIVE DATABASE_URL out of
// .env.local — but .env.local is flipped between database-1 (sandbox) and
// database-2 (PRODUCTION) by hand, and the two drift, so "whatever the env says"
// is a coin flip about which one you are altering. Pass an explicit target:
//
//   DATABASE_URL=postgresql://…database-1… node scripts/apply-e240.mjs
//
// An explicit process.env.DATABASE_URL wins over the file. The host is printed
// before anything is written either way — read it before trusting the run.
import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, from: "process env (explicit override)" };
  const env = readFileSync(".env.local", "utf8");
  const m = env.match(/^DATABASE_URL=(.*)$/m);
  if (!m) throw new Error("No active DATABASE_URL in .env.local and none in the environment.");
  return { url: m[1].trim().replace(/^["']|["']$/g, ""), from: ".env.local" };
}

const { url, from } = resolveUrl();
const ddl = readFileSync("drizzle/E-240_nbfc_dealer_direct_requests.sql", "utf8");

const EXPECTED_MSG_COLS = [
  "attachments", "author_user_id", "created_at", "id", "lead_id", "message",
  "party", "request_id",
];
const EXPECTED_IDX = [
  "nbfc_doc_request_messages_request_created_idx",
  "nbfc_doc_request_messages_lead_idx",
];

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  const host = new URL(url).hostname;
  console.log("HOST:", host, `(from ${from})`);
  console.log(
    host.startsWith("database-2")
      ? "  ^^ database-2 IS PRODUCTION."
      : host.startsWith("database-1")
        ? "  ^^ database-1 is sandbox."
        : "",
  );

  const hasWrapper = await sql`SELECT to_regclass('nbfc_doc_requests') AS t`;
  if (hasWrapper[0].t === null) {
    // Fail with the real reason rather than a bare 42P01 from mid-file.
    console.log("FAILED — nbfc_doc_requests does not exist on this DB (E-200 not applied). Apply E-200 first.");
    process.exit(1);
  }

  await sql.unsafe(ddl);

  const flag = await sql`
    SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns
     WHERE table_name = 'nbfc_doc_requests' AND column_name = 'dealer_direct'`;
  const msgCols = await sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'nbfc_doc_request_messages'
     ORDER BY column_name`;
  const idx = await sql`
    SELECT indexname FROM pg_indexes
     WHERE tablename = 'nbfc_doc_request_messages'`;
  const rows = await sql`SELECT count(*)::int AS n FROM nbfc_doc_request_messages`;
  // Every pre-existing wrapper must have landed on the admin-gated path.
  const direct = await sql`
    SELECT count(*)::int AS n FROM nbfc_doc_requests WHERE dealer_direct IS TRUE`;
  const total = await sql`SELECT count(*)::int AS n FROM nbfc_doc_requests`;

  const gotMsg = msgCols.map((r) => r.column_name);
  const gotIdx = idx.map((r) => r.indexname);
  const missingMsg = EXPECTED_MSG_COLS.filter((c) => !gotMsg.includes(c));
  const missingIdx = EXPECTED_IDX.filter((i) => !gotIdx.includes(i));
  const flagOk = flag.length === 1 && flag[0].data_type === "boolean";

  console.log(
    flagOk
      ? `OK — nbfc_doc_requests.dealer_direct present (boolean, default ${flag[0].column_default}, nullable=${flag[0].is_nullable}).`
      : "FAILED — nbfc_doc_requests.dealer_direct is absent or not boolean.",
  );
  console.log(
    missingMsg.length === 0
      ? `OK — nbfc_doc_request_messages present with ${gotMsg.length} columns, ${rows[0].n} rows.`
      : `FAILED — nbfc_doc_request_messages missing ${JSON.stringify(missingMsg)}.`,
  );
  console.log(
    missingIdx.length === 0
      ? "OK — both indexes present (request_id+created_at, lead_id)."
      : `FAILED — missing index(es) ${JSON.stringify(missingIdx)}.`,
  );
  console.log(
    `INFO — ${total[0].n} existing wrapper(s), ${direct[0].n} flagged dealer_direct` +
      (direct[0].n === 0 ? " (correct: every pre-existing request stays on the admin-gated path)." : " — expected 0 on a fresh apply."),
  );

  if (!flagOk || missingMsg.length || missingIdx.length) process.exit(1);
} finally {
  await sql.end();
}
