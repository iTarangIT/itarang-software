import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { inventory } from "@/lib/db/schema";
import { logInventoryEvent } from "@/lib/inventory/events";
import { InventoryStatus } from "@/lib/inventory/status";

type TxLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export class InventoryLifecycleError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "InventoryLifecycleError";
    this.statusCode = statusCode;
  }
}

export interface ReserveInventoryInput {
  tx: TxLike;
  serial: string;
  dealerId?: string | null;
  leadId: string;
  performedBy?: string | null;
  notes?: string;
  when?: Date;
}

export interface ReleaseInventoryInput {
  tx: TxLike;
  serial: string;
  dealerId?: string | null;
  leadId?: string | null;
  performedBy?: string | null;
  notes?: string;
  when?: Date;
}

export interface SellInventoryInput {
  tx: TxLike;
  serial: string;
  dealerId?: string | null;
  leadId?: string | null;
  performedBy?: string | null;
  notes?: string;
  soldAt?: Date;
}

async function findBySerial(tx: TxLike, serial: string) {
  const [row] = await tx
    .select()
    .from(inventory)
    .where(eq(inventory.serial_number, serial))
    .limit(1);
  if (!row) {
    throw new InventoryLifecycleError(`Serial '${serial}' not found`, 404);
  }
  return row;
}

function ensureDealer(rowDealerId: string | null, expectedDealerId?: string | null) {
  if (!expectedDealerId) return;
  if (rowDealerId !== expectedDealerId) {
    throw new InventoryLifecycleError(
      `Serial is assigned to dealer '${rowDealerId ?? "none"}', not '${expectedDealerId}'`,
      409,
    );
  }
}

async function updateStatus(
  tx: TxLike,
  rowId: string,
  serial: string,
  fromStatus: string,
  toStatus: InventoryStatus,
  set: Partial<typeof inventory.$inferInsert>,
  performedBy?: string | null,
  leadId?: string | null,
  notes?: string,
  when?: Date,
) {
  const at = when ?? new Date();
  const [updated] = await tx
    .update(inventory)
    .set({
      ...set,
      status: toStatus,
      updated_at: at,
    })
    .where(and(eq(inventory.id, rowId), eq(inventory.status, fromStatus)))
    .returning();

  if (!updated) {
    throw new InventoryLifecycleError(
      `Serial '${serial}' status changed concurrently from '${fromStatus}'`,
      409,
    );
  }

  await logInventoryEvent({
    tx,
    serialNumber: serial,
    inventoryId: rowId,
    eventType:
      toStatus === "reserved"
        ? "reserved"
        : toStatus === "available"
          ? "released"
          : "sold",
    fromStatus,
    toStatus,
    leadId: leadId ?? updated.linked_lead_id,
    performedBy: performedBy ?? null,
    notes: notes ?? null,
    performedAt: at,
  });

  return updated;
}

export async function reserveInventorySerial(input: ReserveInventoryInput) {
  const row = await findBySerial(input.tx, input.serial);
  ensureDealer(row.dealer_id, input.dealerId);
  if (row.status !== "available") {
    throw new InventoryLifecycleError(
      `Serial '${input.serial}' is '${row.status}', not available`,
      409,
    );
  }

  return updateStatus(
    input.tx,
    row.id,
    input.serial,
    row.status,
    "reserved",
    { linked_lead_id: input.leadId },
    input.performedBy,
    input.leadId,
    input.notes,
    input.when,
  );
}

export async function releaseInventorySerial(input: ReleaseInventoryInput) {
  const row = await findBySerial(input.tx, input.serial);
  ensureDealer(row.dealer_id, input.dealerId);
  if (row.status !== "reserved") {
    throw new InventoryLifecycleError(
      `Serial '${input.serial}' is '${row.status}', not reserved`,
      409,
    );
  }
  if (input.leadId && row.linked_lead_id && row.linked_lead_id !== input.leadId) {
    throw new InventoryLifecycleError(
      `Serial '${input.serial}' is reserved for lead '${row.linked_lead_id}'`,
      409,
    );
  }

  return updateStatus(
    input.tx,
    row.id,
    input.serial,
    row.status,
    "available",
    { linked_lead_id: null },
    input.performedBy,
    row.linked_lead_id,
    input.notes,
    input.when,
  );
}

export async function sellInventorySerial(input: SellInventoryInput) {
  const row = await findBySerial(input.tx, input.serial);
  ensureDealer(row.dealer_id, input.dealerId);
  if (row.status === "sold") return row;
  if (row.status !== "reserved" && row.status !== "available") {
    throw new InventoryLifecycleError(
      `Serial '${input.serial}' is '${row.status}', cannot be sold`,
      409,
    );
  }

  const soldAt = input.soldAt ?? new Date();
  return updateStatus(
    input.tx,
    row.id,
    input.serial,
    row.status,
    "sold",
    {
      linked_lead_id: input.leadId ?? row.linked_lead_id,
      sold_at: soldAt,
      dispatch_date: row.dispatch_date ?? soldAt,
    },
    input.performedBy,
    input.leadId ?? row.linked_lead_id,
    input.notes,
    soldAt,
  );
}
