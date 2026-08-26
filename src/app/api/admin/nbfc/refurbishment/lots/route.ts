/**
 * E-270 — GET /api/admin/nbfc/refurbishment/lots
 *
 * iTarang's inbox of refurbishment lots from every NBFC. Deliberately NOT
 * tenant scoped: the workshop serves all of them. Reading is open to the whole
 * admin role set; acting is gated in ./[id]/route.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveAdminActor, statusFromError, ADMIN_ROLES } from "@/lib/nbfc/admin/auth";
import { listLots } from "@/lib/nbfc/recovery/refurbishment-lots";
import { LOT_STATUSES } from "@/lib/nbfc/recovery/refurbishment-lot-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveAdminActor(req.headers);
    if (!(ADMIN_ROLES as readonly string[]).includes(actor.role)) {
      throw new Error("FORBIDDEN: not an admin");
    }
    const url = new URL(req.url);
    const raw = url.searchParams.get("status") ?? "open";
    const status = ([...LOT_STATUSES, "open", "closed", "all"] as string[]).includes(raw)
      ? (raw as Parameters<typeof listLots>[0]["status"])
      : "open";
    const tenant = url.searchParams.get("tenant_id");
    const result = await listLots({ tenant_id: tenant || null, status });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(e) }, { status: statusFromError(msg) });
  }
}
