/**
 * One-off seed: set each NBFC-financed battery's IMEI equal to its serial
 * (battery) number, so the Battery Immobilisation modal's Submit button enables.
 *
 * The immobilisation modal sources `imei` from inventory.iot_imei_no joined on
 * inventory.serial_number = nbfc_loans.vehicleno (see case-detail/route.ts).
 * Financed TK- batteries have no inventory row at all, so the modal sees a null
 * IMEI. This script:
 *   - UPDATEs iot_imei_no = serial_number for loan batteries that already have
 *     an inventory row but a null IMEI.
 *   - INSERTs a minimal valid inventory row (iot_imei_no = serial_number) for
 *     loan batteries with no inventory row, mirroring an existing battery row's
 *     template (asset_category/asset_type/model_type/created_by/dealer_id).
 *
 * Idempotent: re-running is a no-op once every loan battery has its IMEI set.
 * No constraints are violated — serial_number is already unique, so using it as
 * the IMEI satisfies inventory_imei_unique too.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });
loadDotenv();

async function main() {
  const { db } = await import("@/lib/db");
  const { sql } = await import("drizzle-orm");

  // 1. Reference template from an existing battery inventory row (for the
  //    NOT NULL columns we must supply on INSERT: created_by, plus sensible
  //    asset_category/asset_type/model_type/dealer_id).
  const refRows = (await db.execute(sql`
    SELECT asset_category, asset_type, model_type, created_by, dealer_id,
           voltage_v, capacity_ah, warranty_months
    FROM inventory
    WHERE asset_type = 'battery'
    ORDER BY created_at NULLS LAST
    LIMIT 1
  `)) as unknown as Array<Record<string, unknown>>;
  if (!refRows[0]) {
    throw new Error("No existing battery inventory row to use as a template.");
  }
  const ref = refRows[0];
  console.log("Template row:", ref);

  // 2. All distinct loan batteries (vehicleno) and whether an inventory row exists.
  const loans = (await db.execute(sql`
    SELECT DISTINCT l.vehicleno,
           (inv.serial_number IS NOT NULL) AS has_inventory,
           inv.iot_imei_no
    FROM (SELECT DISTINCT vehicleno FROM nbfc_loans WHERE vehicleno IS NOT NULL) l
    LEFT JOIN inventory inv ON inv.serial_number = l.vehicleno
    ORDER BY l.vehicleno
  `)) as unknown as Array<{
    vehicleno: string;
    has_inventory: boolean;
    iot_imei_no: string | null;
  }>;

  let updated = 0;
  let inserted = 0;
  let skipped = 0;

  await db.transaction(async (tx) => {
    for (const l of loans) {
      const serial = l.vehicleno;
      if (l.iot_imei_no === serial) {
        skipped++;
        continue; // already set correctly
      }

      if (l.has_inventory) {
        // Set IMEI = serial on the existing row (only when not already set).
        await tx.execute(sql`
          UPDATE inventory
          SET iot_imei_no = ${serial},
              iot_enabled = true,
              updated_at  = now()
          WHERE serial_number = ${serial}
            AND iot_imei_no IS DISTINCT FROM ${serial}
        `);
        updated++;
        console.log(`UPDATE  ${serial}  iot_imei_no := ${serial}`);
      } else {
        // Insert a minimal valid inventory row for the financed battery.
        const id = `inv-${serial}`;
        await tx.execute(sql`
          INSERT INTO inventory (
            id, asset_category, asset_type, model_type, serial_number,
            iot_imei_no, iot_enabled, status, is_serialized, warranty_months,
            created_by, dealer_id, voltage_v, capacity_ah, created_at, updated_at
          ) VALUES (
            ${id}, ${ref.asset_category}, ${ref.asset_type}, ${ref.model_type}, ${serial},
            ${serial}, true, 'sold', true, ${(ref.warranty_months as number) ?? 0},
            ${ref.created_by}, ${ref.dealer_id ?? null}, ${ref.voltage_v ?? null},
            ${ref.capacity_ah ?? null}, now(), now()
          )
          ON CONFLICT (serial_number) DO UPDATE
            SET iot_imei_no = EXCLUDED.iot_imei_no,
                iot_enabled = true,
                updated_at  = now()
        `);
        inserted++;
        console.log(`INSERT  ${serial}  iot_imei_no := ${serial}`);
      }
    }
  });

  console.log(`\nDone. inserted=${inserted} updated=${updated} skipped(already set)=${skipped}`);

  // 3. Verify.
  const after = (await db.execute(sql`
    SELECT l.vehicleno, inv.iot_imei_no,
           (inv.iot_imei_no = l.vehicleno) AS imei_matches_serial
    FROM (SELECT DISTINCT vehicleno FROM nbfc_loans WHERE vehicleno IS NOT NULL) l
    LEFT JOIN inventory inv ON inv.serial_number = l.vehicleno
    ORDER BY l.vehicleno
  `)) as unknown as unknown[];
  console.log("=== Verify: loan batteries IMEI ===");
  console.table(after);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
