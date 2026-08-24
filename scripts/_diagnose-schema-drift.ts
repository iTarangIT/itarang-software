// Read-only diagnostic: which columns does schema.ts declare that the live DB
// does not have?
//
// This is the drift that CLAUDE.md warns about, and it always presents the same
// way: a page that renders "Something went wrong loading this data" because
// Drizzle names every column in schema.ts in its SELECT list, so ONE missing
// column fails the whole query. The error names only the first column it hits,
// which is why fixing them one at a time is slow — this lists all of them.
//
//   node --import tsx --env-file=.env.local scripts/_diagnose-schema-drift.ts
//   node --import tsx --env-file=.env.local scripts/_diagnose-schema-drift.ts leads co_borrowers

import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";

import * as schema from "../src/lib/db/schema";

/** Tables the admin KYC case-review route reads, in the order it reads them. */
const CASE_REVIEW_TABLES = [
  "leads",
  "personal_details",
  "kyc_documents",
  "kyc_verifications",
  "consent_records",
  "kyc_verification_metadata",
  "admin_verification_queue",
  "admin_kyc_reviews",
  "digilocker_transactions",
  "other_document_requests",
  "co_borrowers",
  "co_borrower_documents",
  "co_borrower_requests",
];

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const wanted = only.length ? only : CASE_REVIEW_TABLES;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

  console.log("HOST:", new URL(url).hostname, "\n");

  // Build declared-column map from schema.ts by walking every exported pgTable.
  const declared = new Map<string, string[]>();
  for (const value of Object.values(schema)) {
    if (!value || typeof value !== "object") continue;
    let cfg;
    try {
      cfg = getTableConfig(value as PgTable);
    } catch {
      continue; // not a pgTable (enum, relation, type, helper)
    }
    declared.set(
      cfg.name,
      cfg.columns.map((c) => c.name),
    );
  }

  let totalMissing = 0;
  for (const table of wanted) {
    const cols = declared.get(table);
    if (!cols) {
      console.log(`?  ${table} — not declared in schema.ts`);
      continue;
    }
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ${table}`;
    if (rows.length === 0) {
      console.log(`XX ${table} — TABLE MISSING from the database`);
      totalMissing += cols.length;
      continue;
    }
    const live = new Set(rows.map((r) => r.column_name));
    const missing = cols.filter((c) => !live.has(c));
    if (missing.length === 0) {
      console.log(`OK ${table} (${cols.length} cols)`);
    } else {
      totalMissing += missing.length;
      console.log(`XX ${table} — ${missing.length} column(s) declared but ABSENT:`);
      for (const m of missing) console.log(`      - ${m}`);
    }
  }

  console.log(
    totalMissing === 0
      ? "\nNo drift on these tables. The failure is NOT an unapplied migration."
      : `\n${totalMissing} missing column(s). Every SELECT touching them fails.`,
  );

  await sql.end({ timeout: 5 });
}

void main();
