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
  console.log("Adding doc_for column to kyc_documents...");

  await sql`
    ALTER TABLE kyc_documents
      ADD COLUMN IF NOT EXISTS doc_for VARCHAR(20) NOT NULL DEFAULT 'customer'
  `;
  console.log("doc_for column added (or already existed).");

  const result = await sql<{ column_name: string; column_default: string | null }[]>`
    SELECT column_name, column_default
    FROM information_schema.columns
    WHERE table_name = 'kyc_documents' AND column_name = 'doc_for'
  `;
  console.log("Verified:");
  for (const row of result) console.log(`  - ${row.column_name} default=${row.column_default}`);

  await sql.end();
  console.log("Migration complete.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
