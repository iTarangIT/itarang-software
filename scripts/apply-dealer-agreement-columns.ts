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
  console.log("Adding dealer agreement columns to dealer_onboarding_applications...");

  await sql`
    ALTER TABLE dealer_onboarding_applications
      ADD COLUMN IF NOT EXISTS owner_landline VARCHAR(20),
      ADD COLUMN IF NOT EXISTS sales_manager_name TEXT,
      ADD COLUMN IF NOT EXISTS sales_manager_email TEXT,
      ADD COLUMN IF NOT EXISTS sales_manager_mobile VARCHAR(20),
      ADD COLUMN IF NOT EXISTS itarang_signatory_1_name TEXT,
      ADD COLUMN IF NOT EXISTS itarang_signatory_1_email TEXT,
      ADD COLUMN IF NOT EXISTS itarang_signatory_1_mobile VARCHAR(20),
      ADD COLUMN IF NOT EXISTS itarang_signatory_2_name TEXT,
      ADD COLUMN IF NOT EXISTS itarang_signatory_2_email TEXT,
      ADD COLUMN IF NOT EXISTS itarang_signatory_2_mobile VARCHAR(20)
  `;
  console.log("All 10 columns added (or already existed).");

  const result = await sql<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'dealer_onboarding_applications'
      AND column_name IN (
        'owner_landline',
        'sales_manager_name', 'sales_manager_email', 'sales_manager_mobile',
        'itarang_signatory_1_name', 'itarang_signatory_1_email', 'itarang_signatory_1_mobile',
        'itarang_signatory_2_name', 'itarang_signatory_2_email', 'itarang_signatory_2_mobile'
      )
    ORDER BY column_name
  `;
  console.log(`Verified ${result.length}/10 columns present:`);
  for (const row of result) console.log(`  - ${row.column_name}`);

  await sql.end();
  console.log("Migration complete.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
