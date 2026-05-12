/**
 * E-048 — GET /api/iot/battery/[serialNumber]/freshness  (BRD §6.2.5)
 *
 * Looks up an iot_devices row by serial_number and returns its freshness
 * classification per the §6.2.5 freshness table.
 *
 * Auth: triple-guarded admin test bypass (mirrors the E-045 register-device
 * route; iot_devices is dealer-scoped at the schema level — there is no
 * tenant_id column to scope on, so portfolio-scoping is enforced by the
 * upstream consumer routes that already pin a tenant context. This endpoint
 * is therefore the lowest-level lookup of the freshness label).
 *
 * Response shape:
 *   { serial: string, last_seen: string|null, freshness: <label>, badge: string }
 *
 * Errors:
 *   404 — no iot_devices row for serialNumber
 *   401/403 — auth gate failures
 *   500 — unexpected
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { iotDevices } from "@/lib/db/schema";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";
import { classifyFreshness } from "@/lib/iot/freshness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ serialNumber: string }> },
) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;

  const { serialNumber } = await ctx.params;
  if (!serialNumber || typeof serialNumber !== "string") {
    return NextResponse.json(
      { ok: false, message: "Missing serialNumber path segment" },
      { status: 400 },
    );
  }

  try {
    const [row] = await db
      .select({
        serial_number: iotDevices.serial_number,
        last_seen: iotDevices.last_seen,
      })
      .from(iotDevices)
      .where(eq(iotDevices.serial_number, serialNumber))
      .limit(1);

    if (!row) {
      return NextResponse.json(
        { ok: false, message: "Device not found" },
        { status: 404 },
      );
    }

    const { freshness, badge } = classifyFreshness(row.last_seen);
    return NextResponse.json({
      serial: row.serial_number,
      last_seen: row.last_seen
        ? new Date(row.last_seen).toISOString()
        : null,
      freshness,
      badge,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, message: "Failed to load freshness", error: msg },
      { status: 500 },
    );
  }
}
