export const INVENTORY_STATUSES = [
  "available",
  "reserved",
  "sold",
  "written_off",
  "transferred_out",
  "transferred_in",
] as const;

export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

export function normalizeInventoryStatus(status: string | null | undefined): string {
  if (!status) return "available";
  const s = status.trim().toLowerCase();
  if (s === "in_stock") return "available";
  if (s === "write_off") return "written_off";
  return s;
}

export const INVENTORY_EVENT_TYPES = [
  "uploaded",
  "reserved",
  "released",
  "sold",
  "written_off",
  "transfer_initiated",
  "transfer_received",
  "iot_linked",
  "edited",
] as const;

export type InventoryEventType = (typeof INVENTORY_EVENT_TYPES)[number];
