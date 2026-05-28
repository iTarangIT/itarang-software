/**
 * BRD §6.2.2 — IoT device registration service.
 *
 * Idempotent. Looks up an existing iot_devices row by serial_number OR
 * imei_id (either uniquely identifies a registered device). Inserts when
 * absent. Accepts an optional Drizzle transaction so inventory upload
 * callers can run registration atomically with the inventory insert.
 *
 * Race-safe: a concurrent insert that loses the unique-constraint race
 * re-reads and returns the winning row.
 */
import { eq, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { iotDevices } from "@/lib/db/schema";

type Db = typeof db;

export interface RegisterDeviceInput {
  serialNumber: string;
  imeiId: string;
  dealerId?: string | null;
  model?: string | null;
  category?: string | null;
}

export interface RegisterDeviceResult {
  deviceId: string;
  status: string;
  /** true if an existing row was returned; false if a fresh row was inserted. */
  reused: boolean;
}

export async function registerIotDevice(
  input: RegisterDeviceInput,
  tx?: Db,
): Promise<RegisterDeviceResult> {
  const conn: Db = tx ?? db;
  const { serialNumber, imeiId } = input;
  const deviceId = `IOT-${imeiId}`;

  const existing = await conn
    .select({
      device_id: iotDevices.device_id,
      device_status: iotDevices.device_status,
    })
    .from(iotDevices)
    .where(
      or(
        eq(iotDevices.serial_number, serialNumber),
        eq(iotDevices.imei_id, imeiId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return {
      deviceId: existing[0].device_id,
      status: existing[0].device_status ?? "registered",
      reused: true,
    };
  }

  try {
    const [inserted] = await conn
      .insert(iotDevices)
      .values({
        device_id: deviceId,
        serial_number: serialNumber,
        imei_id: imeiId,
        dealer_id: input.dealerId ?? null,
        model: input.model ?? null,
        category: input.category ?? null,
        device_status: "registered",
      })
      .returning({
        device_id: iotDevices.device_id,
        device_status: iotDevices.device_status,
      });

    return {
      deviceId: inserted.device_id,
      status: inserted.device_status ?? "registered",
      reused: false,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/duplicate key|unique constraint/i.test(msg)) {
      const winner = await conn
        .select({
          device_id: iotDevices.device_id,
          device_status: iotDevices.device_status,
        })
        .from(iotDevices)
        .where(
          or(
            eq(iotDevices.serial_number, serialNumber),
            eq(iotDevices.imei_id, imeiId),
          ),
        )
        .limit(1);
      if (winner.length > 0) {
        return {
          deviceId: winner[0].device_id,
          status: winner[0].device_status ?? "registered",
          reused: true,
        };
      }
    }
    throw e;
  }
}
