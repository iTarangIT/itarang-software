/**
 * Backfill loan_sanctions for E-026:
 *   1. Stamp nbfc_id on rows where it is NULL by case-insensitively matching
 *      loan_approved_by → nbfc.legal_name → nbfc.tenant_id (E-026B bridge).
 *   2. Promote status='dealer_approved' rows to 'disbursed', filling
 *      disbursed_at = COALESCE(dealer_approved_at, NOW()).
 *
 * Run:  npx tsx scripts/backfill-nbfc-id-on-loan-sanctions.ts
 *
 * Idempotent: re-running reports zero rows updated.
 *
 * Prereqs: drizzle/E-026_loan_sanctions_nbfc_lifecycle.sql and
 * drizzle/E-026B_nbfc_tenant_bridge.sql must already be applied.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

async function main() {
  console.log("Backfilling loan_sanctions (E-026)…\n");

  // 1. Stamp nbfc_id from loan_approved_by ↔ nbfc.legal_name match.
  const stamped = await db.execute(sql`
    WITH matched AS (
      SELECT ls.id AS sanction_id, n.tenant_id
      FROM   loan_sanctions ls
      JOIN   nbfc n
             ON LOWER(TRIM(n.legal_name)) = LOWER(TRIM(ls.loan_approved_by))
      WHERE  ls.nbfc_id IS NULL
        AND  ls.loan_approved_by IS NOT NULL
        AND  n.tenant_id IS NOT NULL
    )
    UPDATE loan_sanctions ls
    SET    nbfc_id = m.tenant_id,
           updated_at = NOW()
    FROM   matched m
    WHERE  ls.id = m.sanction_id
    RETURNING ls.id;
  `);
  const stampedCount = Array.isArray(stamped) ? stamped.length : (stamped as { length?: number }).length ?? 0;
  console.log(`  nbfc_id stamped on ${stampedCount} loan_sanctions row(s).`);

  // 2. Promote dealer_approved → disbursed.
  const promoted = await db.execute(sql`
    UPDATE loan_sanctions
    SET    status = 'disbursed',
           disbursed_at = COALESCE(dealer_approved_at, NOW()),
           updated_at = NOW()
    WHERE  status = 'dealer_approved'
    RETURNING id;
  `);
  const promotedCount = Array.isArray(promoted) ? promoted.length : (promoted as { length?: number }).length ?? 0;
  console.log(`  dealer_approved → disbursed on ${promotedCount} row(s).`);

  // 3. Report rows still missing nbfc_id (likely lenders without a portal tenant).
  const stillMissing = await db.execute<{ count: number; sample: string }>(sql`
    SELECT COUNT(*)::int AS count,
           STRING_AGG(DISTINCT loan_approved_by, ', ' ORDER BY loan_approved_by) AS sample
    FROM   loan_sanctions
    WHERE  nbfc_id IS NULL
      AND  loan_approved_by IS NOT NULL
  `);
  const arr = stillMissing as unknown as Array<{ count: number; sample: string | null }>;
  const remaining = arr[0]?.count ?? 0;
  if (remaining > 0) {
    console.log(`\n  ${remaining} row(s) still have nbfc_id IS NULL.`);
    console.log(`  Distinct loan_approved_by values without an nbfc_tenants match: ${arr[0]?.sample ?? "(none)"}`);
    console.log(`  → onboard those lenders as portal tenants OR create an nbfc.tenant_id manually, then re-run.`);
  } else {
    console.log("\n  All non-null loan_approved_by values resolved to a tenant.");
  }

  console.log("\nDone.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
