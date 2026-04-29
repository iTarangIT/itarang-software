/**
 * Seeds dealer inventory so Step 4 (Product Selection) renders with real
 * battery / charger / paraphernalia stock and the GST-aware pricing flow.
 *
 * Usage (recommended — Node 20+ loads .env.local before module init):
 *   node --env-file=.env.local --import tsx scripts/seed-step4-inventory.ts -- --lead <LEAD_ID>
 *   node --env-file=.env.local --import tsx scripts/seed-step4-inventory.ts -- --dealer <DEALER_ID>
 *
 * `npx tsx` alone won't work because the dotenv hoisting in this file races
 * the db client's env read at module init.
 *
 * --lead resolves dealer + category + lead's primary_product_id from the leads
 * row. --dealer skips lead resolution and seeds the full battery matrix.
 *
 * Re-runnable: prior rows tagged with oem_invoice_number LIKE 'STEP4-SEED-%'
 * for the dealer are removed first.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { and, eq, like } from "drizzle-orm";

import { db } from "../src/lib/db";
import {
  inventory,
  leads,
  oems,
  productCategories,
  products,
  users,
} from "../src/lib/db/schema";

type Args = { lead?: string; dealer?: string; category?: string };

function parseArgs(): Args {
  const out: Args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lead") out.lead = argv[++i];
    else if (a === "--dealer") out.dealer = argv[++i];
    else if (a === "--category") out.category = argv[++i];
  }
  return out;
}

// Battery rate matrix from WhatsApp #2, mapped to existing 51/61/64/72 V tiers.
type BatterySpec = {
  voltage_v: number;
  capacity_ah: number;
  rate: number;
};
const BATTERY_MATRIX: BatterySpec[] = [
  // 51V tier — WhatsApp rate sheet + interpolated 132AH
  { voltage_v: 51, capacity_ah: 105, rate: 42000 },
  { voltage_v: 51, capacity_ah: 132, rate: 53000 },
  { voltage_v: 51, capacity_ah: 140, rate: 57000 },
  { voltage_v: 51, capacity_ah: 153, rate: 73000 },
  { voltage_v: 51, capacity_ah: 206, rate: 94000 },
  { voltage_v: 51, capacity_ah: 232, rate: 98500 },
  { voltage_v: 51, capacity_ah: 314, rate: 127000 },
  // 61V tier
  { voltage_v: 61, capacity_ah: 105, rate: 50300 },
  { voltage_v: 61, capacity_ah: 132, rate: 61000 },
  { voltage_v: 61, capacity_ah: 140, rate: 65000 },
  { voltage_v: 61, capacity_ah: 153, rate: 83000 },
  { voltage_v: 61, capacity_ah: 206, rate: 111000 },
  { voltage_v: 61, capacity_ah: 232, rate: 113000 },
  { voltage_v: 61, capacity_ah: 314, rate: 144500 },
  // 64V tier
  { voltage_v: 64, capacity_ah: 105, rate: 52300 },
  { voltage_v: 64, capacity_ah: 132, rate: 64000 },
  { voltage_v: 64, capacity_ah: 140, rate: 69600 },
  { voltage_v: 64, capacity_ah: 153, rate: 88000 },
  { voltage_v: 64, capacity_ah: 232, rate: 118500 },
  // 72V tier
  { voltage_v: 72, capacity_ah: 105, rate: 59300 },
  { voltage_v: 72, capacity_ah: 132, rate: 71000 },
  { voltage_v: 72, capacity_ah: 140, rate: 79300 },
  { voltage_v: 72, capacity_ah: 232, rate: 136500 },
];

// Non-battery products use distinct voltage/capacity sentinels because the
// products table has a unique (category_id, voltage_v, capacity_ah) constraint.
// Negative values stay clear of real battery rows.
const CHARGERS = [
  { name: "Eco Star Charger", sku: "CHG-ECOSTAR-3W", price: 5100, gst: 5, sentinelV: -1, sentinelAh: -1 },
  { name: "Trontk Charger", sku: "CHG-TRONTK-3W", price: 6700, gst: 5, sentinelV: -1, sentinelAh: -2 },
];

const PARAPHERNALIA = [
  { asset_type: "Harness", model: "0.75m", name: "Harness 0.75m", sku: "PARA-HARNESS-075", price: 550, gst: 18, sentinelV: -2, sentinelAh: -1 },
  { asset_type: "Harness", model: "1.5m", name: "Harness 1.5m", sku: "PARA-HARNESS-150", price: 850, gst: 18, sentinelV: -2, sentinelAh: -2 },
  { asset_type: "DigitalSOC", model: "Std", name: "Digital SOC", sku: "PARA-DIGITAL-SOC", price: 600, gst: 18, sentinelV: -3, sentinelAh: -1 },
  { asset_type: "VoltSOC", model: "Std", name: "Volt SOC (Voltmeter)", sku: "PARA-VOLT-SOC", price: 250, gst: 18, sentinelV: -3, sentinelAh: -2 },
  { asset_type: "IOT", model: "Std", name: "IoT Tracker", sku: "PARA-IOT-STD", price: 4500, gst: 18, sentinelV: -4, sentinelAh: -1 },
];

const DEFAULT_CATEGORY_NAME = "3W Batteries";
const DEFAULT_CATEGORY_SLUG = "3w-batteries";
const SEED_INVOICE_PREFIX = "STEP4-SEED";
const VOLTAGE_TO_MODEL_TYPE = (v: number) => `3W-${v}V`;

function todayMinusDays(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function gstSnap(rate: number, gstPct: number) {
  const gstAmount = Math.round(rate * gstPct) / 100;
  return {
    inventory_amount: rate.toFixed(2),
    gst_percent: gstPct.toFixed(2),
    gst_amount: gstAmount.toFixed(2),
    final_amount: (rate + gstAmount).toFixed(2),
  };
}

async function ensureCategory(name: string) {
  const [existing] = await db
    .select()
    .from(productCategories)
    .where(eq(productCategories.name, name))
    .limit(1);
  if (existing) return existing;
  const slug = name === DEFAULT_CATEGORY_NAME ? DEFAULT_CATEGORY_SLUG : name.toLowerCase().replace(/\s+/g, "-");
  const [created] = await db
    .insert(productCategories)
    .values({ name, slug, is_active: true })
    .returning();
  console.log(`  • created category ${name}`);
  return created;
}

async function ensureOem(creatorUserId: string) {
  const [existing] = await db.select().from(oems).limit(1);
  if (existing) return existing;
  const id = `OEM-STEP4-SEED-001`;
  const [created] = await db
    .insert(oems)
    .values({
      id,
      business_entity_name: "Seed OEM Pvt Ltd",
      gstin: "27AAACS0000A1Z5",
      bank_account_number: "0000000000000000",
      ifsc_code: "HDFC0000001",
      created_by: creatorUserId,
    })
    .returning();
  console.log(`  • created OEM ${id}`);
  return created;
}

async function getCreatorUser(): Promise<string> {
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "admin"))
    .limit(1);
  if (admin) return admin.id;
  const [any] = await db.select({ id: users.id }).from(users).limit(1);
  if (!any) throw new Error("No users in DB — cannot set inventory.created_by. Seed users first.");
  return any.id;
}

async function upsertProduct(opts: {
  category_id: string;
  name: string;
  slug: string;
  sku: string;
  asset_type: string;
  voltage_v: number | null;
  capacity_ah: number | null;
  price: number;
  is_serialized: boolean;
  warranty_months: number;
}) {
  const [existing] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.sku, opts.sku))
    .limit(1);
  if (existing) {
    await db
      .update(products)
      .set({
        price: opts.price,
        asset_type: opts.asset_type,
        voltage_v: opts.voltage_v ?? 0,
        capacity_ah: opts.capacity_ah ?? 0,
        warranty_months: opts.warranty_months,
        is_active: true,
        status: "active",
      })
      .where(eq(products.id, existing.id));
    return existing.id;
  }
  // products.voltage_v / capacity_ah are NOT NULL in the deployed DB
  // (stricter than the Drizzle schema). Use 0 sentinel for non-battery
  // SKUs (chargers, paraphernalia).
  const [created] = await db
    .insert(products)
    .values({
      category_id: opts.category_id,
      name: opts.name,
      slug: opts.slug,
      sku: opts.sku,
      asset_type: opts.asset_type,
      voltage_v: opts.voltage_v ?? 0,
      capacity_ah: opts.capacity_ah ?? 0,
      price: opts.price,
      hsn_code: "85076000",
      is_serialized: opts.is_serialized,
      warranty_months: opts.warranty_months,
      status: "active",
      is_active: true,
    })
    .returning({ id: products.id });
  return created.id;
}

function makeInvId(suffix: string, dateStr: string): string {
  return `INV-${dateStr}-${suffix}`.slice(0, 80);
}

async function clearPriorSeed(dealerId: string) {
  const result = await db
    .delete(inventory)
    .where(
      and(
        eq(inventory.dealer_id, dealerId),
        like(inventory.oem_invoice_number, `${SEED_INVOICE_PREFIX}%`),
      ),
    );
  console.log(`  • cleared prior STEP4-SEED rows for dealer ${dealerId}`, result?.count ?? "");
}

async function main() {
  const args = parseArgs();
  if (!args.lead && !args.dealer) {
    console.error("Usage: --lead <LEAD_ID> | --dealer <DEALER_ID> [--category <NAME>]");
    process.exit(2);
  }

  let dealerId: string | null = args.dealer ?? null;
  let categoryName: string = args.category ?? DEFAULT_CATEGORY_NAME;
  let leadPrimaryProductId: string | null = null;

  if (args.lead) {
    const [row] = await db
      .select({
        dealer_id: leads.dealer_id,
        product_category_id: leads.product_category_id,
        primary_product_id: leads.primary_product_id,
      })
      .from(leads)
      .where(eq(leads.id, args.lead))
      .limit(1);
    if (!row) {
      console.error(`Lead not found: ${args.lead}`);
      process.exit(2);
    }
    dealerId = row.dealer_id ?? dealerId;
    leadPrimaryProductId = row.primary_product_id ?? null;
    if (row.product_category_id) {
      const [cat] = await db
        .select({ name: productCategories.name })
        .from(productCategories)
        .where(eq(productCategories.id, row.product_category_id))
        .limit(1);
      if (cat?.name) categoryName = cat.name;
    }
  }

  if (!dealerId) {
    console.error("Could not resolve dealer_id from lead. Pass --dealer explicitly.");
    process.exit(2);
  }

  console.log(`▶ Seeding Step 4 inventory`);
  console.log(`  dealer_id        : ${dealerId}`);
  console.log(`  category         : ${categoryName}`);
  console.log(`  lead primary id  : ${leadPrimaryProductId ?? "(none — full matrix)"}`);

  const category = await ensureCategory(categoryName);
  const creatorId = await getCreatorUser();
  const oem = await ensureOem(creatorId);

  await clearPriorSeed(dealerId);

  // Stagger invoice dates so all three age badges (fresh / ageing / old) appear.
  // Battery API thresholds: ≤90d = fresh, 91–180 = ageing, >180 = old.
  const ageBuckets = [
    { label: "FRESH", days: 10 },
    { label: "AGEING", days: 120 },
    { label: "OLD", days: 220 },
  ];

  // ── Battery products + inventory ───────────────────────────────────────
  let batRowsInserted = 0;
  const batteryProductIds: string[] = [];
  for (const spec of BATTERY_MATRIX) {
    const sku = `3W-${spec.voltage_v}V-${spec.capacity_ah}AH`;
    const name = `3W Battery ${spec.voltage_v}V ${spec.capacity_ah}AH`;
    const slug = sku.toLowerCase();
    const productId = await upsertProduct({
      category_id: category.id,
      name,
      slug,
      sku,
      asset_type: "Battery",
      voltage_v: spec.voltage_v,
      capacity_ah: spec.capacity_ah,
      price: spec.rate,
      is_serialized: true,
      warranty_months: 36,
    });
    batteryProductIds.push(productId);

    const snap = gstSnap(spec.rate, 18);
    const modelType = VOLTAGE_TO_MODEL_TYPE(spec.voltage_v);
    for (const bucket of ageBuckets) {
      const invoiceDate = todayMinusDays(bucket.days);
      const dateStr = invoiceDate.toISOString().slice(0, 10).replace(/-/g, "");
      const serial = `${SEED_INVOICE_PREFIX}-BAT-${spec.voltage_v}V-${spec.capacity_ah}AH-${bucket.label}`;
      await db.insert(inventory).values({
        id: makeInvId(`BAT-${spec.voltage_v}-${spec.capacity_ah}-${bucket.label}`, dateStr),
        product_id: productId,
        oem_id: oem.id,
        oem_name: oem.business_entity_name,
        asset_category: categoryName,
        asset_type: "Battery",
        model_type: modelType,
        is_serialized: true,
        serial_number: serial,
        manufacturing_date: todayMinusDays(bucket.days + 30),
        expiry_date: todayMinusDays(bucket.days - 365 * 10),
        oem_invoice_date: invoiceDate,
        oem_invoice_number: `${SEED_INVOICE_PREFIX}-BAT-${dateStr}-${spec.voltage_v}-${spec.capacity_ah}-${bucket.label}`,
        ...snap,
        status: "available",
        dealer_id: dealerId,
        soc_percent: (60 + Math.floor(Math.random() * 40)).toFixed(2),
        soc_last_sync_at: new Date(),
        created_by: creatorId,
      });
      batRowsInserted++;
    }
  }

  // If the lead's primary_product_id is not in the matrix (legacy SKU),
  // seed three additional inventory rows pointing at that exact product so
  // the lead's Step 4 isn't filtered to zero rows.
  if (leadPrimaryProductId && !batteryProductIds.includes(leadPrimaryProductId)) {
    const [legacy] = await db
      .select({
        id: products.id,
        name: products.name,
        voltage_v: products.voltage_v,
        capacity_ah: products.capacity_ah,
        price: products.price,
      })
      .from(products)
      .where(eq(products.id, leadPrimaryProductId))
      .limit(1);
    if (legacy) {
      const v = legacy.voltage_v ?? 51;
      const a = legacy.capacity_ah ?? 105;
      const matched =
        BATTERY_MATRIX.find((m) => m.voltage_v === v && m.capacity_ah === a) ??
        { voltage_v: v, capacity_ah: a, rate: legacy.price ?? 50000 };
      const snap = gstSnap(matched.rate, 18);
      const modelType = VOLTAGE_TO_MODEL_TYPE(v);
      // Make sure the product has a price set so paraphernalia/UI shows totals.
      if (!legacy.price || legacy.price !== matched.rate) {
        await db.update(products).set({ price: matched.rate }).where(eq(products.id, legacy.id));
      }
      for (const bucket of ageBuckets) {
        const invoiceDate = todayMinusDays(bucket.days);
        const dateStr = invoiceDate.toISOString().slice(0, 10).replace(/-/g, "");
        await db.insert(inventory).values({
          id: makeInvId(`BAT-LEAD-${bucket.label}`, dateStr),
          product_id: legacy.id,
          oem_id: oem.id,
          oem_name: oem.business_entity_name,
          asset_category: categoryName,
          asset_type: "Battery",
          model_type: modelType,
          is_serialized: true,
          serial_number: `${SEED_INVOICE_PREFIX}-BAT-LEAD-${legacy.id.slice(0, 8)}-${bucket.label}`,
          manufacturing_date: todayMinusDays(bucket.days + 30),
          expiry_date: todayMinusDays(bucket.days - 365 * 10),
          oem_invoice_date: invoiceDate,
          oem_invoice_number: `${SEED_INVOICE_PREFIX}-BAT-LEAD-${dateStr}-${bucket.label}`,
          ...snap,
          status: "available",
          dealer_id: dealerId,
          soc_percent: (60 + Math.floor(Math.random() * 40)).toFixed(2),
          soc_last_sync_at: new Date(),
          created_by: creatorId,
        });
        batRowsInserted++;
      }
      console.log(`  • added 3 inventory rows pegged to lead's primary_product_id (${legacy.name})`);
    }
  }

  // ── Charger products + inventory ──────────────────────────────────────
  // Chargers are filtered by inventory.model_type matching the selected
  // battery's model_type. We seed one charger inventory row per voltage
  // tier per charger SKU so any battery selection has compatible chargers.
  const VOLTAGE_TIERS = Array.from(new Set(BATTERY_MATRIX.map((b) => b.voltage_v)));
  let chgRowsInserted = 0;
  for (const c of CHARGERS) {
    const productId = await upsertProduct({
      category_id: category.id,
      name: c.name,
      slug: c.sku.toLowerCase(),
      sku: c.sku,
      asset_type: "Charger",
      voltage_v: c.sentinelV,
      capacity_ah: c.sentinelAh,
      price: c.price,
      is_serialized: true,
      warranty_months: 12,
    });
    const snap = gstSnap(c.price, c.gst);
    for (const v of VOLTAGE_TIERS) {
      for (const bucket of ageBuckets) {
        const invoiceDate = todayMinusDays(bucket.days);
        const dateStr = invoiceDate.toISOString().slice(0, 10).replace(/-/g, "");
        const modelType = VOLTAGE_TO_MODEL_TYPE(v);
        const serial = `${SEED_INVOICE_PREFIX}-${c.sku}-${v}V-${bucket.label}`;
        await db.insert(inventory).values({
          id: makeInvId(`CHG-${c.sku.slice(-6)}-${v}-${bucket.label}`, dateStr),
          product_id: productId,
          oem_id: oem.id,
          oem_name: oem.business_entity_name,
          asset_category: categoryName,
          asset_type: "Charger",
          model_type: modelType,
          is_serialized: true,
          serial_number: serial,
          manufacturing_date: todayMinusDays(bucket.days + 30),
          expiry_date: todayMinusDays(bucket.days - 365 * 5),
          oem_invoice_date: invoiceDate,
          oem_invoice_number: `${SEED_INVOICE_PREFIX}-${c.sku}-${dateStr}-${v}-${bucket.label}`,
          ...snap,
          status: "available",
          dealer_id: dealerId,
          created_by: creatorId,
        });
        chgRowsInserted++;
      }
    }
  }

  // ── Paraphernalia products + inventory (count-tracked) ───────────────
  let paraRowsInserted = 0;
  for (const p of PARAPHERNALIA) {
    const productId = await upsertProduct({
      category_id: category.id,
      name: p.name,
      slug: p.sku.toLowerCase(),
      sku: p.sku,
      asset_type: p.asset_type,
      voltage_v: p.sentinelV,
      capacity_ah: p.sentinelAh,
      price: p.price,
      is_serialized: false,
      warranty_months: 0,
    });
    const snap = gstSnap(p.price, p.gst);
    const invoiceDate = todayMinusDays(15);
    const dateStr = invoiceDate.toISOString().slice(0, 10).replace(/-/g, "");
    await db.insert(inventory).values({
      id: makeInvId(`PARA-${p.sku.slice(-8)}`, dateStr),
      product_id: productId,
      oem_id: oem.id,
      oem_name: oem.business_entity_name,
      asset_category: categoryName,
      asset_type: p.asset_type,
      model_type: p.model,
      is_serialized: false,
      serial_number: null,
      quantity: 50,
      manufacturing_date: todayMinusDays(45),
      expiry_date: todayMinusDays(-365 * 5),
      oem_invoice_date: invoiceDate,
      oem_invoice_number: `${SEED_INVOICE_PREFIX}-${p.sku}-${dateStr}`,
      ...snap,
      status: "available",
      dealer_id: dealerId,
      created_by: creatorId,
    });
    paraRowsInserted++;
  }

  console.log(`✅ Seed complete`);
  console.log(`   batteries  : ${batRowsInserted} rows`);
  console.log(`   chargers   : ${chgRowsInserted} rows`);
  console.log(`   paraphern. : ${paraRowsInserted} rows`);
  console.log(`   dealer     : ${dealerId}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
