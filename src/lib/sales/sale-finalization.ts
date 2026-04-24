import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  afterSalesRecords,
  deployedAssets,
  deploymentHistory,
  inventory,
  products,
} from "@/lib/db/schema";
import { generateId } from "@/lib/api-utils";

// BRD V2 §3.4 / §3.6 — on successful sale (cash confirm or finance dispatch),
// we must: (1) mark battery+charger inventory as sold, (2) create a warranty
// record (deployedAssets), (3) open an after-sales record. All three operations
// must run inside a single DB transaction so we never half-commit.

type TxLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface FinalizeSaleInput {
  tx: TxLike;
  leadId: string;
  batterySerial: string;
  chargerSerial: string;
  dealerId: string;
  customerName: string | null;
  customerPhone: string | null;
  paymentMode: "cash" | "finance";
  performedBy: string; // user UUID
  soldAt: Date;
}

export interface FinalizeSaleOutput {
  warrantyId: string;
  warrantyStart: Date;
  warrantyEnd: Date;
  afterSalesId: string;
}

export async function finalizeSale(
  input: FinalizeSaleInput,
): Promise<FinalizeSaleOutput> {
  const { tx, leadId, batterySerial, chargerSerial, dealerId, soldAt, performedBy } = input;

  // 1. Load battery + charger rows from inventory, together with the battery's
  //    warranty duration (from products).
  const batteryRows = await tx
    .select({
      id: inventory.id,
      serial_number: inventory.serial_number,
      asset_category: inventory.asset_category,
      asset_type: inventory.asset_type,
      model_type: inventory.model_type,
      product_id: inventory.product_id,
      warranty_months: products.warranty_months,
    })
    .from(inventory)
    .leftJoin(products, eq(inventory.product_id, products.id))
    .where(eq(inventory.serial_number, batterySerial))
    .limit(1);
  const battery = batteryRows[0];
  if (!battery) throw new Error(`Battery ${batterySerial} not found`);

  const chargerRows = await tx
    .select({ id: inventory.id })
    .from(inventory)
    .where(eq(inventory.serial_number, chargerSerial))
    .limit(1);
  const charger = chargerRows[0];
  if (!charger) throw new Error(`Charger ${chargerSerial} not found`);

  // 2. Mark inventory sold. dispatch_date & linked_lead_id are persisted so the
  //    item can be traced back to its sale.
  await tx
    .update(inventory)
    .set({
      status: "sold",
      dispatch_date: soldAt,
      linked_lead_id: leadId,
      updated_at: soldAt,
    })
    .where(eq(inventory.id, battery.id));
  await tx
    .update(inventory)
    .set({
      status: "sold",
      dispatch_date: soldAt,
      linked_lead_id: leadId,
      updated_at: soldAt,
    })
    .where(eq(inventory.id, charger.id));

  // 3. Warranty record — one row per deployment, anchored on the battery.
  const warrantyMonths = battery.warranty_months ?? 24;
  const warrantyEnd = new Date(soldAt);
  warrantyEnd.setMonth(warrantyEnd.getMonth() + warrantyMonths);

  const warrantyId = await generateId("ASSET");
  await tx.insert(deployedAssets).values({
    id: warrantyId,
    inventory_id: battery.id,
    lead_id: null, // leads (varchar) vs dealerLeads FK mismatch — trace via afterSalesRecords
    dealer_id: dealerId,
    customer_name: input.customerName,
    customer_phone: input.customerPhone,
    serial_number: battery.serial_number,
    asset_category: battery.asset_category,
    asset_type: battery.asset_type,
    model_type: battery.model_type,
    deployment_date: soldAt,
    payment_type: input.paymentMode === "cash" ? "upfront" : "finance",
    payment_status: input.paymentMode === "cash" ? "paid" : "pending",
    warranty_start_date: soldAt,
    warranty_end_date: warrantyEnd,
    warranty_status: "active",
    status: "active",
    created_by: performedBy,
    created_at: soldAt,
    updated_at: soldAt,
  });

  // 4. Deployment history entry
  await tx.insert(deploymentHistory).values({
    id: await generateId("DPH"),
    deployed_asset_id: warrantyId,
    action: "deployed",
    description: `Sale confirmed (${input.paymentMode}). Warranty activated.`,
    performed_by: performedBy,
    metadata: { lead_id: leadId, payment_mode: input.paymentMode },
    created_at: soldAt,
  });

  // 5. After-sales record (service handle)
  const afterSalesId = await generateId("AS");
  await tx.insert(afterSalesRecords).values({
    id: afterSalesId,
    lead_id: leadId,
    warranty_id: warrantyId,
    battery_serial: battery.serial_number,
    customer_id: null, // no standalone customer record yet — lead acts as the customer handle
    dealer_id: dealerId,
    payment_mode: input.paymentMode,
    opened_at: soldAt,
    status: "active",
    created_at: soldAt,
    updated_at: soldAt,
  });

  return {
    warrantyId,
    warrantyStart: soldAt,
    warrantyEnd,
    afterSalesId,
  };
}
