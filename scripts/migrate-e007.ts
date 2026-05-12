/**
 * E-007 — direct-SQL migration to extend nbfc_lsp_agreements with
 * agreement_id, signatory fields, expires_at, audit_trail_url, signing_date,
 * created_by. Idempotent (`ADD COLUMN IF NOT EXISTS`).
 *
 * Run via: NBFC_ENV_FILE=keys/sandbox.env npx tsx scripts/migrate-e007.ts
 * (or sourced env). Uses DATABASE_URL.
 */
import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const sql = postgres(url, { ssl: 'require', prepare: false });
  try {
    console.log('[E-007] applying nbfc_lsp_agreements column additions…');
    await sql`ALTER TABLE nbfc_lsp_agreements ADD COLUMN IF NOT EXISTS agreement_id varchar(50)`;
    await sql`ALTER TABLE nbfc_lsp_agreements ADD COLUMN IF NOT EXISTS signing_date date`;
    await sql`ALTER TABLE nbfc_lsp_agreements ADD COLUMN IF NOT EXISTS nbfc_signatory_name varchar(200)`;
    await sql`ALTER TABLE nbfc_lsp_agreements ADD COLUMN IF NOT EXISTS nbfc_signatory_email varchar(200)`;
    await sql`ALTER TABLE nbfc_lsp_agreements ADD COLUMN IF NOT EXISTS itarang_signatory_1_name varchar(200)`;
    await sql`ALTER TABLE nbfc_lsp_agreements ADD COLUMN IF NOT EXISTS itarang_signatory_1_email varchar(200)`;
    await sql`ALTER TABLE nbfc_lsp_agreements ADD COLUMN IF NOT EXISTS itarang_signatory_2_name varchar(200)`;
    await sql`ALTER TABLE nbfc_lsp_agreements ADD COLUMN IF NOT EXISTS itarang_signatory_2_email varchar(200)`;
    await sql`ALTER TABLE nbfc_lsp_agreements ADD COLUMN IF NOT EXISTS audit_trail_url text`;
    await sql`ALTER TABLE nbfc_lsp_agreements ADD COLUMN IF NOT EXISTS expires_at timestamptz`;
    await sql`ALTER TABLE nbfc_lsp_agreements ADD COLUMN IF NOT EXISTS created_by integer`;
    // Unique constraint on agreement_id (only after column exists). Use a
    // partial unique index to skip the legacy NULL-filled rows.
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS nbfc_lsp_agreements_agreement_id_key
      ON nbfc_lsp_agreements(agreement_id)
      WHERE agreement_id IS NOT NULL
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS nbfc_lsp_agreements_agreement_id_idx
      ON nbfc_lsp_agreements(agreement_id)
    `;
    console.log('[E-007] migration complete');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
