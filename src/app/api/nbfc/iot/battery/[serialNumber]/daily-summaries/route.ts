/**
 * GET /api/nbfc/iot/battery/[serialNumber]/daily-summaries?days=N — E-050
 * (BRD §6.2.7)
 *
 * Returns the most recent N daily-summary rows for one battery, ordered by
 * summary_date DESC (newest first). Powers the CDS scoring input strip in the
 * battery drawer.
 *
 * Default days=30, capped at 365 by the zod validator.
 *
 * AC5 covers this endpoint.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { desc, eq } from "drizzle-orm";
import { telemetryDailySummary } from "@/lib/db/schema";
import {
  resolveBatteryActor,
  getDeviceBySerial,
  isSerialAuthorised,
  errorToStatus,
} from "@/lib/nbfc/battery-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export async function GET(
  req: Request,
  ctx: { params: Promise<{ serialNumber: string }> },
) {
  try {
    const { serialNumber } = await ctx.params;
    if (!serialNumber) {
      return NextResponse.json({ ok: false, error: "MISSING_SERIAL" }, { status: 400 });
    }
    const actor = await resolveBatteryActor(req.headers);

    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse({
      days: url.searchParams.get("days") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "INVALID_QUERY", details: parsed.error.flatten() },
        { status: 422 },
      );
    }
    const { days } = parsed.data;

    const device = await getDeviceBySerial(serialNumber);
    if (!device) {
      return NextResponse.json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
    }

    const allowed = await isSerialAuthorised(device, actor);
    if (!allowed) {
      return NextResponse.json({ ok: false, error: "FORBIDDEN" }, { status: 403 });
    }

    const summaries = await db
      .select()
      .from(telemetryDailySummary)
      .where(eq(telemetryDailySummary.serial_number, serialNumber))
      .orderBy(desc(telemetryDailySummary.summary_date))
      .limit(days);

    return NextResponse.json({ serial: serialNumber, summaries });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: errorToStatus(msg) });
  }
}
