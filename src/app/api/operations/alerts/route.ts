/**
 * GET   /api/operations/alerts — open alerts, recent resolved, and the rules.
 * PATCH /api/operations/alerts — acknowledge or resolve one alert.
 *
 * Acknowledge and resolve are deliberately different actions:
 *
 *   acknowledge — "a human has seen this". The alert stays OPEN and the
 *                 condition is still true; it just stops being a surprise.
 *   resolve     — "consider this closed". Manual resolve exists for conditions
 *                 the collector cannot observe recovering (a box that was
 *                 decommissioned, a metric that will never report again).
 *
 * A manually resolved alert can legitimately re-open on the next tick if the
 * breach is still live — that is correct, not a bug. The partial unique index
 * only constrains UNRESOLVED rows, so the new alert is a new row.
 */

import { NextResponse, type NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { getAlertsView } from "@/lib/operations/alertsView";
import { requireOperationsAdmin } from "@/lib/operations/route-guard";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireOperationsAdmin();
  if (!auth.ok) return auth.response;

  try {
    return NextResponse.json({ success: true, data: await getAlertsView() });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        error: {
          message: e instanceof Error ? e.message : "Failed to read alerts",
          hint: "If this says a relation does not exist, apply drizzle/E-210_ops_monitoring.sql to this database.",
        },
      },
      { status: 500 },
    );
  }
}

const PatchBody = z.object({
  id: z.string().uuid(),
  action: z.enum(["acknowledge", "resolve"]),
});

export async function PATCH(request: NextRequest) {
  const auth = await requireOperationsAdmin();
  if (!auth.ok) return auth.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: { message: "Body must be JSON" } },
      { status: 400 },
    );
  }

  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: { message: "id (uuid) and action are required" } },
      { status: 400 },
    );
  }

  const { id, action } = parsed.data;

  try {
    const updated =
      action === "acknowledge"
        ? ((await db.execute(sql`
            UPDATE ops_alerts
            SET acknowledged_at = NOW(),
                acknowledged_by = ${auth.user.id},
                status = 'acknowledged'
            WHERE id = ${id}::uuid AND resolved_at IS NULL
            RETURNING id
          `)) as unknown as Array<Record<string, unknown>>)
        : ((await db.execute(sql`
            UPDATE ops_alerts
            SET resolved_at = NOW(), status = 'resolved'
            WHERE id = ${id}::uuid AND resolved_at IS NULL
            RETURNING id
          `)) as unknown as Array<Record<string, unknown>>);

    if (updated.length === 0) {
      // Already resolved, or never existed. Not an error worth a 500 — the
      // caller's view was simply stale.
      return NextResponse.json(
        { success: false, error: { message: "Alert not found or already resolved" } },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, data: { id, action } });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        error: { message: e instanceof Error ? e.message : "Failed to update alert" },
      },
      { status: 500 },
    );
  }
}
