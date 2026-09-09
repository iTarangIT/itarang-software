/**
 * E-292 — GET /api/refurbisher/lots
 *
 * The refurbisher partner's own lot list, scoped to users.refurbisher_id and
 * REDACTED (no PI, no advance / balance, no final bill, no margin). Default
 * view is `open`; `?status=` accepts a lot status, open | closed | all.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { requireRefurbisher, refurbisherStatusFromError } from "@/lib/refurbisher/auth";
import { listLots } from "@/lib/nbfc/recovery/refurbishment-lots";
import { LOT_STATUSES } from "@/lib/nbfc/recovery/refurbishment-lot-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const actor = await requireRefurbisher();
    const url = new URL(req.url);
    const raw = url.searchParams.get("status") ?? "open";
    const status = ([...LOT_STATUSES, "open", "closed", "all"] as string[]).includes(raw)
      ? (raw as Parameters<typeof listLots>[0]["status"])
      : "open";
    const result = await listLots({ refurbisher_id: actor.refurbisher_id, status });
    return NextResponse.json({ ok: true, ...result, refurbisher: { id: actor.refurbisher_id, name: actor.name } });
  } catch (e) {
    const status = refurbisherStatusFromError(e);
    return NextResponse.json({ ok: false, error: clientError(e) }, { status });
  }
}
