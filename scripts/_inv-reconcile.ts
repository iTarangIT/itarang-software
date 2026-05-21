import "./_load-env";
import { db } from "@/lib/db";
import { inventory, paraphernaliaStock, accounts } from "@/lib/db/schema";
import { eq, sql, and } from "drizzle-orm";

async function main() {
  const dealerId = "ACC-ITARANG-20260427-b79e09";

  const acct = await db
    .select({ id: accounts.id, name: accounts.business_entity_name, code: accounts.dealer_code })
    .from(accounts)
    .where(eq(accounts.id, dealerId));
  console.log("Dealer account:", JSON.stringify(acct));

  const invByStatus = await db
    .select({ status: inventory.status, n: sql<number>`count(*)::int` })
    .from(inventory)
    .where(eq(inventory.dealer_id, dealerId))
    .groupBy(inventory.status);
  console.log("\n--- inventory table by status ---");
  console.table(invByStatus);

  const invByType = await db
    .select({
      asset_type: inventory.asset_type,
      asset_category: inventory.asset_category,
      n: sql<number>`count(*)::int`,
    })
    .from(inventory)
    .where(and(eq(inventory.dealer_id, dealerId), eq(inventory.status, "available")))
    .groupBy(inventory.asset_type, inventory.asset_category);
  console.log("\n--- inventory AVAILABLE by asset_type + category ---");
  console.table(invByType);

  const para = await db
    .select()
    .from(paraphernaliaStock)
    .where(eq(paraphernaliaStock.dealer_id, dealerId));
  console.log("\n--- paraphernalia_stock rows ---");
  console.table(
    para.map((p) => ({
      item_type: p.item_type,
      item_label: p.item_label,
      avail: p.available_qty,
      reserved: p.reserved_qty,
      sold: p.sold_qty,
      cost: p.unit_cost,
    })),
  );

  const paraAvail = para.reduce((s, p) => s + (p.available_qty ?? 0), 0);
  const invAvail = invByStatus.find((r) => r.status === "available")?.n ?? 0;
  console.log("\n=== RECONCILE ===");
  console.log(
    "inventory available =", invAvail,
    "| paraphernalia_stock available =", paraAvail,
    "| sum =", Number(invAvail) + paraAvail,
    "(dealer page shows 87)",
  );

  process.exit(0);
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.stack : e);
  process.exit(1);
});
