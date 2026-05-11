import { db } from "@/lib/db";
import { generateId } from "@/lib/api-utils";
import { inventoryEvents } from "@/lib/db/schema";
import { InventoryEventType, normalizeInventoryStatus } from "@/lib/inventory/status";

type TxLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface LogInventoryEventInput {
  tx?: TxLike;
  serialNumber: string;
  inventoryId?: string | null;
  eventType: InventoryEventType;
  fromStatus?: string | null;
  toStatus?: string | null;
  leadId?: string | null;
  performedBy?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown> | null;
  performedAt?: Date;
}

export async function logInventoryEvent(input: LogInventoryEventInput) {
  const runner = input.tx ?? db;
  const id = await generateId("INVEVT");
  const performedAt = input.performedAt ?? new Date();

  await runner.insert(inventoryEvents).values({
    id,
    serial_number: input.serialNumber,
    inventory_id: input.inventoryId ?? null,
    event_type: input.eventType,
    from_status: input.fromStatus ? normalizeInventoryStatus(input.fromStatus) : null,
    to_status: input.toStatus ? normalizeInventoryStatus(input.toStatus) : null,
    lead_id: input.leadId ?? null,
    performed_by: input.performedBy ?? null,
    notes: input.notes ?? null,
    metadata: input.metadata ?? null,
    performed_at: performedAt,
  });

  return id;
}
