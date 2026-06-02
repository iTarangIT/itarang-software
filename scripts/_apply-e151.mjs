import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = readFileSync(".env.local", "utf8");
const m = env.match(/^DATABASE_URL=(.*)$/m);
if (!m) { console.error("DATABASE_URL not found"); process.exit(1); }
const url = m[1].trim().replace(/^["']|["']$/g, "");

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 15 });
try {
  await sql.unsafe(`ALTER TABLE "nbfc_loan_agreements" ADD COLUMN IF NOT EXISTS "source_document_url" text;`);
  const r = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'nbfc_loan_agreements' AND column_name = 'source_document_url'`;
  console.log(
    r[0]
      ? `E-151 applied. nbfc_loan_agreements.source_document_url = ${r[0].data_type}`
      : "E-151 ran but column not found (unexpected)",
  );
} finally {
  await sql.end();
}
