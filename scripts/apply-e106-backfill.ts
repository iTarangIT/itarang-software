import "dotenv/config";
import * as dotenv from "dotenv";
import postgres from "postgres";

dotenv.config({ path: ".env.local" });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Make sure .env.local exists with the AWS RDS connection string.");
  process.exit(1);
}

const sql = postgres(url, {
  ssl: { rejectUnauthorized: false },
  max: 1,
});

async function main() {
  console.log("E-106: Backfilling canonical `dealers` rows for approved applications...");

  const beforeRows = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM dealers`;
  const before = Number(beforeRows[0]?.count ?? 0);
  console.log(`  dealers row count before: ${before}`);

  const approvedRows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count
    FROM dealer_onboarding_applications
    WHERE onboarding_status = 'approved' AND dealer_code IS NOT NULL
  `;
  const approved = Number(approvedRows[0]?.count ?? 0);
  console.log(`  approved applications with dealer_code: ${approved}`);

  await sql.unsafe(`
    INSERT INTO dealers (
      dealer_id, company_name, company_type, gst_number, pan_number,
      registered_address, bank_name, bank_account_number, bank_ifsc,
      bank_beneficiary, owner_name, owner_phone, owner_email,
      finance_enabled, onboarding_status, application_id, activated_at
    )
    SELECT
      a.dealer_code,
      a.company_name,
      COALESCE(a.company_type, 'individual'),
      a.gst_number,
      a.pan_number,
      a.registered_address,
      a.bank_name,
      a.account_number,
      a.ifsc_code,
      a.beneficiary_name,
      a.owner_name,
      a.owner_phone,
      a.owner_email,
      COALESCE(a.finance_enabled, false),
      'active',
      a.id::text,
      COALESCE(a.approved_at, NOW())
    FROM dealer_onboarding_applications a
    WHERE a.onboarding_status = 'approved'
      AND a.dealer_code IS NOT NULL
    ON CONFLICT (dealer_id) DO NOTHING
  `);

  const afterRows = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM dealers`;
  const after = Number(afterRows[0]?.count ?? 0);
  console.log(`  dealers row count after:  ${after}`);
  console.log(`  inserted: ${after - before}`);

  const sample = await sql<
    { dealer_id: string; owner_email: string | null; onboarding_status: string; finance_enabled: boolean }[]
  >`
    SELECT dealer_id, owner_email, onboarding_status, finance_enabled
    FROM dealers
    ORDER BY activated_at DESC NULLS LAST
    LIMIT 5
  `;
  console.log("  last 5 dealers:");
  for (const r of sample) {
    console.log(`    ${r.dealer_id}  ${r.owner_email ?? "(no email)"}  status=${r.onboarding_status}  finance=${r.finance_enabled}`);
  }

  await sql.end();
  console.log("Done.");
}

main().catch((err) => {
  console.error("E-106 backfill failed:", err);
  process.exit(1);
});
