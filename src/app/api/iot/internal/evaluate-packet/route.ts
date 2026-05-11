/**
 * E-049 — Internal trigger for the per-packet alert evaluator.
 *
 * Exposed because E-046 (telemetry ingestion route) is downstream of
 * E-049 — the BRD says "evaluate alert rules" is step 6 of POST
 * /api/iot/ingest, but until that ingestion route exists, AC1/AC2/AC3 of
 * E-049 (per-packet evaluator behaviour) need a callable entry point so
 * the executable spec can verify the engine in isolation. Once E-046
 * ships, the ingestion route will call `evaluatePacketAlerts(...)`
 * directly and this internal trigger remains available for unit-style
 * tests and admin dry-runs.
 *
 * Auth model: admin via `requireAdminOrTestBypass` — the same triple-
 * gated bypass used by the rest of the NBFC loop. Never callable in
 * production without an admin session.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";
import {
  evaluatePacketAlerts,
  type PacketInput,
} from "@/lib/iot/alerts/evaluatePacketAlerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  serial_number: z.string().min(1).max(50),
  bms_status: z.string().optional().nullable(),
  temperature_c: z.union([z.number(), z.string()]).optional().nullable(),
  soc_percent: z.number().int().optional().nullable(),
  soh_percent: z.number().int().optional().nullable(),
  charger_connected: z.boolean().optional().nullable(),
  daily_km: z.union([z.number(), z.string()]).optional().nullable(),
  gps_lat: z.union([z.number(), z.string()]).optional().nullable(),
  gps_lng: z.union([z.number(), z.string()]).optional().nullable(),
  device_time: z.string().datetime().optional().nullable(),
});

export async function POST(req: NextRequest) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "INVALID_JSON" },
      { status: 400 },
    );
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "VALIDATION", issues: parsed.error.issues },
      { status: 422 },
    );
  }

  try {
    const result = await evaluatePacketAlerts(parsed.data as PacketInput);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.error("[iot/internal/evaluate-packet] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
