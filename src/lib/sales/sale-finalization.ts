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
import { logInventoryEvent } from "@/lib/inventory/events";
import { sellInventorySerial } from "@/lib/inventory/lifecycle";

// BRD V2 §3.4 / §3.5 / §3.6 — finalize the sale lifecycle.
// Two phases per BRD inventory state machine:
//
//   phase='dispatched' (finance Step 5 OTP success):
//     - inventory.status = 'dispatched', dispatch_date = now, linked_lead_id
//     - warranty (deployedAssets) created, warranty_start_date = now
//     - after-sales record opened
//     - inventory.sold_at NOT set yet (waits for delivery confirmation)
//
//   phase='sold' (cash Confirm Sale, OR finance delivery confirmation 1d
//   after dispatch):
//     - inventory.status = 'sold', sold_at = now
//     - dispatch_date set if not already (cash skips dispatched, so set both)
//     - warranty + after-sales created if not already (used only on cash —
//       on the finance path warranty/after-sales were created at dispatch
//       and we just flip statuses; see markDispatchedAsSold).
//
// All writes run inside the caller-supplied transaction so we never half-commit.

type TxLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type FinalizeSalePhase = "dispatched" | "sold";

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
  soldAt: Date; // for phase='dispatched' this is dispatch_date; for 'sold' it's sold_at
  /**
   * 'dispatched' for the finance OTP step (intermediate state).
   * 'sold' for cash confirmation or for the cron / mark-delivered finalization.
   * Defaults to 'sold' so existing callers stay one-shot.
   */
  phase?: FinalizeSalePhase;
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
  const {
    tx,
    leadId,
    batterySerial,
    chargerSerial,
    dealerId,
    soldAt,
    performedBy,
  } = input;
  const phase: FinalizeSalePhase = input.phase ?? "sold";

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

  // 2. Update inventory.
  //    - phase='dispatched': inventory enters the 'dispatched' state. sold_at
  //      is left null so the cron / Mark Delivered click can set it later.
  //    - phase='sold' (cash, or post-dispatch finalization): inventory hits
  //      'sold' and sold_at is recorded.
  if (phase === "dispatched") {
    await tx
      .update(inventory)
      .set({
        status: "dispatched",
        dispatch_date: soldAt,
        linked_lead_id: leadId,
        updated_at: soldAt,
      })
      .where(eq(inventory.id, battery.id));
    await tx
      .update(inventory)
      .set({
        status: "dispatched",
        dispatch_date: soldAt,
        linked_lead_id: leadId,
        updated_at: soldAt,
      })
      .where(eq(inventory.id, charger.id));

    await logInventoryEvent({
      tx,
      serialNumber: batterySerial,
      inventoryId: battery.id,
      eventType: "edited",
      fromStatus: "reserved",
      toStatus: "dispatched",
      leadId,
      performedBy,
      notes: "Finance dispatch confirmed",
      performedAt: soldAt,
    });
    await logInventoryEvent({
      tx,
      serialNumber: chargerSerial,
      inventoryId: charger.id,
      eventType: "edited",
      fromStatus: "reserved",
      toStatus: "dispatched",
      leadId,
      performedBy,
      notes: "Finance dispatch confirmed",
      performedAt: soldAt,
    });
  } else {
    await sellInventorySerial({
      tx,
      serial: batterySerial,
      leadId,
      dealerId,
      performedBy,
      soldAt,
      notes: `Finalized sale (${input.paymentMode})`,
    });
    await sellInventorySerial({
      tx,
      serial: chargerSerial,
      leadId,
      dealerId,
      performedBy,
      soldAt,
      notes: `Finalized sale (${input.paymentMode})`,
    });
  }

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

  // 4. Deployment history entry — labelled by phase so the audit trail
  //    distinguishes a dispatched-but-not-delivered asset from a sold one.
  await tx.insert(deploymentHistory).values({
    id: await generateId("DPH"),
    deployed_asset_id: warrantyId,
    action: phase === "dispatched" ? "dispatched" : "deployed",
    description:
      phase === "dispatched"
        ? `Dispatched (${input.paymentMode}). Warranty activated; awaiting delivery confirmation.`
        : `Sale confirmed (${input.paymentMode}). Warranty activated.`,
    performed_by: performedBy,
    metadata: { lead_id: leadId, payment_mode: input.paymentMode, phase },
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

// ─── Phase 2: dispatched → sold ─────────────────────────────────────────────
// Used by the daily cron and by the dealer's "Mark Delivered" button. The
// warranty + after-sales rows already exist (created at dispatch), so we just
// flip statuses and stamp sold_at.

export interface MarkDispatchedSoldInput {
  tx: TxLike;
  leadId: string;
  batterySerial: string;
  chargerSerial: string;
  performedBy: string;
  soldAt: Date;
}

export interface MarkDispatchedSoldOutput {
  /** True when at least one inventory row flipped from dispatched → sold. */
  changed: boolean;
}

export async function markDispatchedAsSold(
  input: MarkDispatchedSoldInput,
): Promise<MarkDispatchedSoldOutput> {
  const { tx, leadId, batterySerial, chargerSerial, performedBy, soldAt } = input;

  const flip = async (serial: string) => {
    const result = await tx
      .update(inventory)
      .set({ status: "sold", sold_at: soldAt, updated_at: soldAt })
      .where(
        and(
          eq(inventory.serial_number, serial),
          eq(inventory.status, "dispatched"),
        ),
      )
      .returning({ id: inventory.id });
    return result[0]?.id ?? null;
  };

  const [batteryId, chargerId] = await Promise.all([
    flip(batterySerial),
    flip(chargerSerial),
  ]);
  const changed = Boolean(batteryId || chargerId);

  if (batteryId) {
    await logInventoryEvent({
      tx,
      serialNumber: batterySerial,
      inventoryId: batteryId,
      eventType: "sold",
      fromStatus: "dispatched",
      toStatus: "sold",
      leadId,
      performedBy,
      notes: "Delivery confirmed",
      performedAt: soldAt,
    });
  }
  if (chargerId) {
    await logInventoryEvent({
      tx,
      serialNumber: chargerSerial,
      inventoryId: chargerId,
      eventType: "sold",
      fromStatus: "dispatched",
      toStatus: "sold",
      leadId,
      performedBy,
      notes: "Delivery confirmed",
      performedAt: soldAt,
    });
  }

  if (changed) {
    // Find the matching deployedAsset to log the deployment-history entry
    // against. We anchor on battery serial (one warranty per deployment).
    const [asset] = await tx
      .select({ id: deployedAssets.id })
      .from(deployedAssets)
      .where(eq(deployedAssets.serial_number, batterySerial))
      .limit(1);
    if (asset) {
      await tx.insert(deploymentHistory).values({
        id: await generateId("DPH"),
        deployed_asset_id: asset.id,
        action: "delivered",
        description: "Delivery confirmed. Inventory marked sold.",
        performed_by: performedBy,
        metadata: { lead_id: leadId, phase: "sold" },
        created_at: soldAt,
      });
    }
  }

  return { changed };
}
