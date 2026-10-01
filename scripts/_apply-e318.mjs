// One-off: apply E-318 to database-1 (sandbox) or database-2 (prod).
//   node scripts/_apply-e318.mjs database-1 --dry-run   everything in ONE transaction, rolled back
//   node scripts/_apply-e318.mjs database-1
//   node scripts/_apply-e318.mjs database-2
// Reads that host's URL from .env.local (commented or not), never prints it.
// The file runs twice (second pass must be a no-op), then the two guarantees the
// migration exists for are exercised on throwaway rows: the requester cannot
// decide their own request, and an application has at most one pending request.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const target = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!["database-1", "database-2"].includes(target)) throw new Error("usage: database-1 | database-2 [--dry-run]");
const line = readFileSync(".env.local", "utf8")
  .split(/\r?\n/)
  .find((l) => /^\s*#?\s*DATABASE_URL=/.test(l) && l.includes(`${target}.`));
if (!line) throw new Error(`no DATABASE_URL for ${target} in .env.local`);
const url = line.replace(/^\s*#?\s*DATABASE_URL=/, "").trim().replace(/^["']|["']$/g, "");
const host = new URL(url).host;
if (!host.startsWith(`${target}.`)) throw new Error(`host mismatch: ${host}`);
console.log("target:", host.split(".")[0], dryRun ? "(dry run — rolled back)" : "");

const ddl = readFileSync("drizzle/E-318_dealer_agreement_override_requests.sql", "utf8");
const ROLLBACK = Symbol("rollback");

// Runs inside a transaction that is always rolled back: leaves no rows behind.
async function exercise(tx) {
  const app = "e318-selftest";
  const refused = async (label, code, run) => {
    try {
      await tx.savepoint(run);
      console.log(`  ${label}: NOT refused  <-- FAIL`);
      return false;
    } catch (e) {
      const ok = e.code === code;
      console.log(`  ${label}: ${ok ? "refused" : `unexpected error ${e.code} ${e.message}`}`);
      return ok;
    }
  };
  const [r] = await tx`
    INSERT INTO dealer_agreement_override_requests (application_id, verdict, request_reason, requested_by)
    VALUES (${app}, 'mismatch', 'self test', 'user-a') RETURNING id`;
  const a = await refused("second pending request for the same application", "23505", (sp) => sp`
    INSERT INTO dealer_agreement_override_requests (application_id, verdict, request_reason, requested_by)
    VALUES (${app}, 'mismatch', 'self test 2', 'user-b')`);
  const b = await refused("requester approving their own request", "23514", (sp) => sp`
    UPDATE dealer_agreement_override_requests SET status = 'approved', decided_by = 'user-a', decided_at = now() WHERE id = ${r.id}`);
  const c = await refused("approval with no approver", "23514", (sp) => sp`
    UPDATE dealer_agreement_override_requests SET status = 'approved' WHERE id = ${r.id}`);
  const ok = await tx`
    UPDATE dealer_agreement_override_requests SET status = 'approved', decided_by = 'user-b', decided_at = now()
     WHERE id = ${r.id} AND status = 'pending' RETURNING id`;
  console.log(`  a second person approving: ${ok.length === 1 ? "accepted" : "NOT accepted  <-- FAIL"}`);
  const again = await tx`
    INSERT INTO dealer_agreement_override_requests (application_id, verdict, request_reason, requested_by)
    VALUES (${app}, 'mismatch', 'after the first was decided', 'user-a') RETURNING id`;
  console.log(`  a new request once the first is decided: ${again.length === 1 ? "accepted" : "NOT accepted  <-- FAIL"}`);
  const docs = await tx`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'accepted')::int AS accepted FROM dealer_agreement_documents`;
  console.log(`  dealer_agreement_documents: ${docs[0].n} rows, ${docs[0].accepted} 'accepted'`);
  if (!(a && b && c && ok.length === 1 && again.length === 1)) throw new Error("E-318 self-test failed");
}

const connect = () => postgres(url, { max: 1, ssl: { rejectUnauthorized: false }, onnotice: (n) => console.log("  notice:", n.message) });

if (dryRun) {
  const sql = connect();
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(ddl);
      console.log("pass 1: ok");
      await tx.unsafe(ddl);
      console.log("pass 2: ok");
      await exercise(tx);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
    console.log("rolled back — nothing was changed");
  } finally {
    await sql.end();
  }
} else {
  for (const pass of [1, 2]) {
    const sql = connect();
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl);
      });
      console.log(`pass ${pass}: ok`);
    } finally {
      await sql.end();
    }
  }
  const v = connect();
  try {
    const cols = await v`
      SELECT table_name, count(*)::int AS columns FROM information_schema.columns
       WHERE table_name IN ('dealer_agreement_override_requests', 'dealer_agreement_documents') GROUP BY 1 ORDER BY 1`;
    const idx = await v`
      SELECT indexname FROM pg_indexes
       WHERE tablename IN ('dealer_agreement_override_requests', 'dealer_agreement_documents') ORDER BY 1`;
    console.table(cols);
    console.log(idx.map((r) => r.indexname).join("\n"));
    await v.begin(async (tx) => {
      await exercise(tx);
      throw ROLLBACK;
    }).catch((e) => {
      if (e !== ROLLBACK) throw e;
    });
    console.log("self-test rows rolled back");
  } finally {
    await v.end();
  }
}
