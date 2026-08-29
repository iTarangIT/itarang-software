/**
 * Seeds N demo BATTERY units into a dealer's inventory.
 *
 * Usage (Node 20+ loads .env.local before module init — `npx tsx` alone races
 * the db client's env read, same caveat as seed-step4-inventory.ts):
 *   node --env-file=.env.local --import tsx scripts/seed-demo-dealer-batteries.ts -- --email <DEALER_EMAIL> [--count 10]
 *   node --env-file=.env.local --import tsx scripts/seed-demo-dealer-batteries.ts -- --dealer <ACC-...> [--count 10]
 *
 * WHY NOT seed-step4-inventory.ts: that script seeds the whole demo catalogue
 * (25 batteries + chargers + paraphernalia) off a hard-coded rate matrix and
 * writes its own `products` rows. This one adds a bounded number of battery
 * units drawn from the ACTIVE `product_master_batteries` rows already in the
 * DB, so the demo stock matches the models the admin add-item / bulk-upload
 * flows would actually produce.
 *
 * Field conventions mirror POST /api/admin/inventory/add-item (the canonical
 * writer): asset_type/inventory_type 'battery', asset_category '3W',
 * model_type = master.model_id, sub_category from compatible_sub_categories[0].
 * Those are the columns listDealerBatteries() and GET /api/dealer/inventory
 * filter on — get them wrong and the rows exist but render nowhere.
 *
 * Re-runnable: prior rows tagged oem_invoice_number LIKE 'DEMO-SEED-%' for the
 * dealer are deleted first, but ONLY while still 'available' — a unit the
 * dealer has already reserved or sold is left alone rather than yanked out
 * from under a live lead.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { and, eq, inArray, like, sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import {
  accounts,
  inventory,
  productMasterBatteries,
  products,
  users,
} from "../src/lib/db/schema";

const SEED_INVOICE_PREFIX = "DEMO-SEED";
const DEFAULT_COUNT = 10;
const GST_PERCENT = 5;

/**
 * Per-model list price. product_master_batteries carries no price and the
 * `products` catalogue only covers a few of the masters, so demo money comes
 * from the same rate sheet seed-step4-inventory.ts uses, keyed on the master's
 * nominal voltage tier (51.2 -> 51, 60.8 -> 61, 73.6 -> 72) and capacity.
 */
const RATE_SHEET: Record<string, number> = {
  "51-45": 21000,
  "51-105": 42000,
  "51-140": 57000,
  "51-153": 73000,
  "51-232": 98500,
  "61-105": 50300,
  "61-140": 65000,
  "61-153": 83000,
  "64-105": 52300,
  "64-140": 69600,
  "64-153": 88000,
  "72-140": 79300,
};
const FALLBACK_RATE = 55000;

function voltageTier(v: number): number {
  if (v <= 55) return 51;
  if (v <= 62) return 61;
  if (v <= 68) return 64;
  return 72;
}

function rateFor(voltageV: number, capacityAh: number): number {
  return RATE_SHEET[`${voltageTier(voltageV)}-${Math.round(capacityAh)}`] ?? FALLBACK_RATE;
}

type Args = { email?: string; dealer?: string; count: number };

function parseArgs(): Args {
  const out: Args = { count: DEFAULT_COUNT };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--email") out.email = argv[++i];
    else if (a === "--dealer") out.dealer = argv[++i];
    else if (a === "--count") out.count = Number(argv[++i]) || DEFAULT_COUNT;
  }
  return out;
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // not json — fall through
    }
  }
  return [];
}

/** Mirrors generateId() in @/lib/api-utils (INV-YYYYMMDD-xxxxxxxx). */
function newId(prefix: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${prefix}-${date}-${rand}`;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  out.setMonth(out.getMonth() + months);
  return out;
}

/**
 * A dealer account is only usable if a users row points at it: every inventory
 * read path keys off `users.dealer_id`, so stock hung on an account with no
 * linked login is invisible in the portal. Fail loudly instead of seeding into
 * a hole.
 */
async function resolveDealer(args: Args): Promise<{ id: string; label: string }> {
  if (args.email) {
    const [u] = await db
      .select({
        id: users.id,
        dealer_id: users.dealer_id,
        name: users.name,
        role: users.role,
      })
      .from(users)
      .where(eq(sql`lower(${users.email})`, args.email.toLowerCase()))
      .limit(1);
    if (!u) throw new Error(`No users row for ${args.email}`);
    if (u.role !== "dealer") throw new Error(`${args.email} has role '${u.role}', not 'dealer'`);
    if (!u.dealer_id) throw new Error(`${args.email} has no users.dealer_id — orphan account`);
    const [acc] = await db
      .select({ id: accounts.id, name: accounts.business_entity_name })
      .from(accounts)
      .where(eq(accounts.id, u.dealer_id))
      .limit(1);
    if (!acc) {
      throw new Error(
        `users.dealer_id '${u.dealer_id}' has no accounts row — orphan account, inventory would be invisible`,
      );
    }
    return { id: acc.id, label: `${acc.name} (${u.name})` };
  }
  if (!args.dealer) throw new Error("Pass --email <dealer email> or --dealer <ACC-...>");
  const [acc] = await db
    .select({ id: accounts.id, name: accounts.business_entity_name })
    .from(accounts)
    .where(eq(accounts.id, args.dealer))
    .limit(1);
  if (!acc) throw new Error(`No accounts row for ${args.dealer}`);
  return { id: acc.id, label: acc.name ?? acc.id };
}

async function creatorUserId(): Promise<string> {
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "admin"))
    .limit(1);
  if (admin) return admin.id;
  const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
  if (!anyUser) throw new Error("No users in DB — cannot set inventory.created_by");
  return anyUser.id;
}

async function main() {
  const args = parseArgs();
  const dealer = await resolveDealer(args);

  console.log("▶ Seeding demo battery inventory");
  console.log(`  dealer : ${dealer.id}  — ${dealer.label}`);
  console.log(`  count  : ${args.count}`);

  const masters = (
    await db
      .select()
      .from(productMasterBatteries)
      .where(eq(productMasterBatteries.status, "active"))
  ).filter((m) => toStringArray(m.compatible_categories).some((c) => c.toUpperCase() === "3W"));

  if (masters.length === 0) {
    throw new Error("No active 3W battery masters in product_master_batteries");
  }
  masters.sort(
    (a, b) =>
      Number(a.voltage_v ?? 0) - Number(b.voltage_v ?? 0) ||
      Number(a.capacity_ah ?? 0) - Number(b.capacity_ah ?? 0),
  );

  const cleared = await db
    .delete(inventory)
    .where(
      and(
        eq(inventory.dealer_id, dealer.id),
        like(inventory.oem_invoice_number, `${SEED_INVOICE_PREFIX}%`),
        eq(inventory.status, "available"),
      ),
    );
  console.log(`  • cleared ${cleared?.count ?? 0} prior available ${SEED_INVOICE_PREFIX} rows`);

  // Map master.model_id -> products.id where the catalogue already has a row,
  // so the dealer inventory list shows a product name, not the raw model id.
  const productRows = await db
    .select({ id: products.id, sku: products.sku })
    .from(products)
    .where(
      inArray(
        products.sku,
        masters.map((m) => m.model_id),
      ),
    );
  const productBySku = new Map(productRows.map((p) => [p.sku, p.id]));

  const creator = await creatorUserId();
  const uploadEventId = newId("UPL");
  const dealerTag = (dealer.id.split("-").pop() ?? dealer.id).slice(0, 8).toUpperCase();
  // Stagger invoice dates so all three ageing badges show in the demo
  // (<=90d fresh / 91-180 ageing / >180 old).
  const ageDays = [12, 26, 41, 58, 74, 96, 118, 141, 168, 194, 212, 233];

  const rows = [];
  for (let i = 0; i < args.count; i++) {
    const m = masters[i % masters.length];
    const voltageV = Number(m.voltage_v ?? 0);
    const capacityAh = Number(m.capacity_ah ?? 0);
    const rate = rateFor(voltageV, capacityAh);
    const gstAmount = Math.round(rate * GST_PERCENT) / 100;
    const invoiceDate = daysAgo(ageDays[i % ageDays.length]);
    const warrantyMonths = m.warranty_months ?? 36;
    const subCategory = toStringArray(m.compatible_sub_categories)[0] ?? "3W";
    const seq = String(i + 1).padStart(3, "0");

    rows.push({
      id: newId("INV"),
      inventory_type: "battery",
      asset_category: "3W",
      asset_type: "battery",
      sub_category: subCategory,
      model_type: m.model_id,
      serial_number: `DEMO-${dealerTag}-${seq}`,
      material_code: `DEMO-MAT-${m.model_id}`.slice(0, 100),
      product_id: productBySku.get(m.model_id) ?? null,
      is_serialized: true,
      voltage_v: m.voltage_v ?? null,
      capacity_ah: m.capacity_ah ?? null,
      star_rating: 4,
      physical_condition: "new",
      hsn_code: "85076000",
      warranty_months: warrantyMonths,
      status: "available",
      dealer_id: dealer.id,
      allocated_to_dealer_at: invoiceDate,
      received_date: invoiceDate,
      pdi_status: "completed",
      pdi_completed_at: invoiceDate,
      iot_enabled: false,
      iot_imei_no: null,
      inventory_amount: rate.toFixed(2),
      gst_percent: GST_PERCENT.toFixed(2),
      gst_amount: gstAmount.toFixed(2),
      final_amount: (rate + gstAmount).toFixed(2),
      oem_name: "Trontek Demo Supplies",
      oem_invoice_number: `${SEED_INVOICE_PREFIX}-${dealerTag}-${seq}`,
      oem_invoice_date: invoiceDate,
      oem_warranty_date: invoiceDate.toISOString().slice(0, 10),
      oem_warranty_months: warrantyMonths,
      oem_warranty_expiry: addMonths(invoiceDate, warrantyMonths).toISOString().slice(0, 10),
      warehouse_location: "Demo Warehouse",
      manufacturing_date: daysAgo(ageDays[i % ageDays.length] + 30),
      created_by: creator,
      created_at: invoiceDate,
      updated_at: invoiceDate,
      upload_event_id: uploadEventId,
    });
  }

  await db.insert(inventory).values(rows);

  for (const r of rows) {
    console.log(
      `  ✓ ${r.serial_number}  ${String(r.model_type).padEnd(22)} ${r.voltage_v}V/${r.capacity_ah}AH  ` +
        `₹${r.final_amount}  invoiced ${r.oem_invoice_date.toISOString().slice(0, 10)}`,
    );
  }
  console.log(`\n✅ Inserted ${rows.length} available battery units for ${dealer.id}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});
