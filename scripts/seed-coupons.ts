/**
 * Seed test coupons for all existing dealer accounts.
 * Run: npx tsx scripts/seed-coupons.ts
 */
import "dotenv/config";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function seed() {
  const client = await pool.connect();
  try {
    // Get all dealer accounts
    const { rows: dealers } = await client.query(
      "SELECT id, business_entity_name FROM accounts LIMIT 20"
    );

    if (!dealers.length) {
      console.log("No dealer accounts found. Nothing to seed.");
      return;
    }

    console.log(`Found ${dealers.length} dealer accounts`);

    for (const dealer of dealers) {
      const suffix = dealer.id.slice(-4); // last 4 chars of dealer ID
      const batchId = `BATCH-TEST-${suffix}`;
      const prefix = `TEST-${suffix}`;
      const count = 10;

      // Check if batch already exists
      const { rows: existing } = await client.query(
        "SELECT id FROM coupon_batches WHERE id = $1",
        [batchId]
      );

      if (existing.length > 0) {
        console.log(`  Batch ${batchId} already exists, skipping ${dealer.id}`);
        continue;
      }

      // Create batch
      await client.query(
        `INSERT INTO coupon_batches (id, name, dealer_id, prefix, coupon_value, total_quantity, expiry_date, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW(), NOW())`,
        [
          batchId,
          `Test Batch - ${dealer.business_entity_name || dealer.id}`,
          dealer.id,
          prefix,
          0, // free coupons for testing
          count,
          new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days
        ]
      );

      // Create coupons
      for (let i = 1; i <= count; i++) {
        const seq = String(i).padStart(3, "0");
        const code = `${prefix}-${seq}`;
        const couponId = `COUPON-TEST-${suffix}-${seq}`;

        try {
          await client.query(
            `INSERT INTO coupon_codes (id, code, batch_id, dealer_id, status, credits_available, discount_type, discount_value, expires_at, created_at)
             VALUES ($1, $2, $3, $4, 'available', 1, 'flat', 0, $5, NOW())
             ON CONFLICT (code) DO NOTHING`,
            [
              couponId,
              code,
              batchId,
              dealer.id,
              new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
            ]
          );
        } catch (e: any) {
          console.log(`  Coupon ${code} already exists or error:`, e.message);
        }
      }

      console.log(
        `  Created batch ${batchId} with ${count} coupons for ${dealer.business_entity_name || dealer.id}`
      );
      console.log(`  Codes: ${prefix}-001 through ${prefix}-${String(count).padStart(3, "0")}`);
    }

    console.log("\nSeed complete!");
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});
