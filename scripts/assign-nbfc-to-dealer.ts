/**
 * Assigns an active NBFC to a dealer so finance-path lead creation
 * (E-105 NO_ACTIVE_NBFC guard) passes.
 *
 * Usage:
 *   npx tsx scripts/assign-nbfc-to-dealer.ts <dealer_code> [nbfc_id_or_short_name]
 *
 * Examples:
 *   npx tsx scripts/assign-nbfc-to-dealer.ts ACC-ITARANG-20260512-abc123
 *     -> picks the first active NBFC and assigns it
 *   npx tsx scripts/assign-nbfc-to-dealer.ts ACC-ITARANG-20260512-abc123 NBFC-001
 *     -> assigns the NBFC with nbfc_id='NBFC-001'
 *
 * Idempotent: re-running with the same args either does nothing (if the
 * assignment already exists and is active) or reactivates a terminated row.
 */
import "dotenv/config";
import * as dotenv from "dotenv";
import postgres from "postgres";

dotenv.config({ path: ".env.local" });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Make sure .env.local exists with the AWS RDS connection string.");
  process.exit(1);
}

const dealerCode = process.argv[2];
const nbfcSelector = process.argv[3] ?? null;

if (!dealerCode) {
  console.error("Usage: npx tsx scripts/assign-nbfc-to-dealer.ts <dealer_code> [nbfc_id_or_short_name]");
  process.exit(1);
}

const sql = postgres(url, {
  ssl: { rejectUnauthorized: false },
  max: 1,
});

async function main() {
  const [dealer] = await sql<{ id: number; dealer_id: string; finance_enabled: boolean; onboarding_status: string }[]>`
    SELECT id, dealer_id, finance_enabled, onboarding_status
    FROM dealers
    WHERE dealer_id = ${dealerCode}
    LIMIT 1
  `;
  if (!dealer) {
    console.error(`No dealer found with dealer_id = ${dealerCode}.`);
    process.exit(1);
  }
  console.log(`Dealer: id=${dealer.id} code=${dealer.dealer_id} status=${dealer.onboarding_status} finance_enabled=${dealer.finance_enabled}`);

  if (!dealer.finance_enabled) {
    console.warn("  ⚠ finance_enabled is false on this dealer. NBFC assignment alone won't help — the FINANCE_NOT_ENABLED gate will still fire. Set dealers.finance_enabled=true first.");
  }

  let nbfcRow: { id: number; nbfc_id: string; short_name: string; status: string } | undefined;
  if (nbfcSelector) {
    [nbfcRow] = await sql<{ id: number; nbfc_id: string; short_name: string; status: string }[]>`
      SELECT id, nbfc_id, short_name, status
      FROM nbfc
      WHERE nbfc_id = ${nbfcSelector} OR short_name = ${nbfcSelector}
      LIMIT 1
    `;
    if (!nbfcRow) {
      console.error(`No NBFC found with nbfc_id or short_name = ${nbfcSelector}.`);
      process.exit(1);
    }
  } else {
    [nbfcRow] = await sql<{ id: number; nbfc_id: string; short_name: string; status: string }[]>`
      SELECT id, nbfc_id, short_name, status
      FROM nbfc
      WHERE status = 'active'
      ORDER BY id ASC
      LIMIT 1
    `;
    if (!nbfcRow) {
      console.error("No active NBFC found in the `nbfc` table.");
      console.error("You need to onboard and activate at least one NBFC before finance-path leads can be created.");
      console.error("Either run the seed script (scripts/seed-nbfc-demo.ts) or onboard an NBFC via the admin UI.");
      process.exit(1);
    }
  }
  console.log(`NBFC:   id=${nbfcRow.id} code=${nbfcRow.nbfc_id} name=${nbfcRow.short_name} status=${nbfcRow.status}`);

  if (nbfcRow.status !== "active") {
    console.warn(`  ⚠ NBFC status is '${nbfcRow.status}', not 'active'. Assignment will be created but the gate may still reject if the NBFC isn't fully approved.`);
  }

  const [existing] = await sql<{ id: number; status: string }[]>`
    SELECT id, status
    FROM dealer_nbfc_assignments
    WHERE dealer_id = ${dealer.id} AND nbfc_id = ${nbfcRow.id}
    LIMIT 1
  `;

  if (existing) {
    if (existing.status === "active") {
      console.log("Assignment already exists and is active. Nothing to do.");
    } else {
      console.log(`Assignment exists with status=${existing.status}; reactivating to 'active'.`);
      await sql`UPDATE dealer_nbfc_assignments SET status = 'active' WHERE id = ${existing.id}`;
    }
  } else {
    console.log("Inserting new assignment with status='active'.");
    await sql`
      INSERT INTO dealer_nbfc_assignments (dealer_id, nbfc_id, enabled_by, status)
      VALUES (${dealer.id}, ${nbfcRow.id}, 0, 'active')
    `;
  }

  const final = await sql<{ id: number; status: string; nbfc_short: string }[]>`
    SELECT a.id, a.status, n.short_name AS nbfc_short
    FROM dealer_nbfc_assignments a
    JOIN nbfc n ON n.id = a.nbfc_id
    WHERE a.dealer_id = ${dealer.id}
  `;
  console.log("Active assignments for this dealer:");
  for (const row of final) {
    console.log(`  id=${row.id} status=${row.status} nbfc=${row.nbfc_short}`);
  }

  await sql.end();
  console.log("Done.");
}

main().catch((err) => {
  console.error("assign-nbfc-to-dealer failed:", err);
  process.exit(1);
});
