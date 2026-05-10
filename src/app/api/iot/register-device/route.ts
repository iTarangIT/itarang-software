/**
 * E-045 — POST /api/iot/register-device
 *
 * Registers an IoT device on inventory upload (BRD §6.2.2). Called internally
 * by inventory add-item / bulk-upload flows when iot_enabled = true and a
 * valid IMEI is present. Auth: admin (or admin test bypass).
 *
 * Idempotency contract (BRD non_functional + AC2):
 *   - If an iot_devices row already exists for the same serial_number OR
 *     imei_id, return the existing { deviceId, status } without inserting.
 *   - device_id is canonicalised to `IOT-${imeiId}`.
 *
 * Validation (AC3):
 *   - imeiId must be 15–20 digits (zod regex). Zod failure → HTTP 422 with
 *     issues list, mirroring other NBFC/admin routes.
 *
 * Inventory cross-check (BRD logic step 2) is deferred — the route trusts the
 * caller (inventory upload handler) to only call it for iot_enabled rows.
 * Adding a hard inventory join here would couple this route to the inventory
 * shape and break the simple "register if missing" contract that downstream
 * units (E-046+) depend on.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { iotDevices } from "@/lib/db/schema";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RegisterDeviceBody = z.object({
  serialNumber: z.string().min(1).max(50),
  imeiId: z.string().regex(/^\d{15,20}$/),
  dealerId: z.string().min(1).max(50),
  model: z.string().min(1).max(100),
  category: z.string().min(1).max(50),
});

export async function POST(req: NextRequest) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, message: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = RegisterDeviceBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        message: "Validation failed",
        issues: parsed.error.issues,
      },
      { status: 422 },
    );
  }

  const { serialNumber, imeiId, dealerId, model, category } = parsed.data;
  const deviceId = `IOT-${imeiId}`;

  try {
    // Idempotency check — match on serial_number OR imei_id (either uniquely
    // identifies an already-registered device).
    const existing = await db
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
      return NextResponse.json({
        deviceId: existing[0].device_id,
        status: existing[0].device_status ?? "registered",
      });
    }

    const [inserted] = await db
      .insert(iotDevices)
      .values({
        device_id: deviceId,
        serial_number: serialNumber,
        imei_id: imeiId,
        dealer_id: dealerId,
        model,
        category,
        device_status: "registered",
      })
      .returning({
        device_id: iotDevices.device_id,
        device_status: iotDevices.device_status,
      });

    // SIM activation hook — no-op stub. When SIMs are iTarang-managed, wire
    // this up to the SIM provider; otherwise keep it as an audit-log marker.
    // (Audit log integration is a follow-up unit; deferred per non_functional.)

    return NextResponse.json({
      deviceId: inserted.device_id,
      status: inserted.device_status ?? "registered",
    });
  } catch (e) {
    // Unique-constraint race — another concurrent call raced us. Re-read and
    // return the winning row (still idempotent from the caller's perspective).
    const msg = e instanceof Error ? e.message : String(e);
    if (/duplicate key|unique constraint/i.test(msg)) {
      const existing = await db
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
        return NextResponse.json({
          deviceId: existing[0].device_id,
          status: existing[0].device_status ?? "registered",
        });
      }
    }
    return NextResponse.json(
      { ok: false, message: "Failed to register device", error: msg },
      { status: 500 },
    );
  }
}
