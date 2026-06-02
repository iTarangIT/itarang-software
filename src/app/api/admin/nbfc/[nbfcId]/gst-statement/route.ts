/**
 * GET /api/admin/nbfc/[id]/gst-statement?month=YYYY-MM
 *
 * §8.1/§8.2 — the month's ledger line items totalled, as the GST statement. It
 * is a usage statement (the wallet is prepaid), not a separate bill. Returns
 * the itemised lines + totals grouped by charge type. Admin-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfc } from "@/lib/db/schema";
import { resolveAdminActor, statusFromError, ADMIN_ROLES } from "@/lib/nbfc/admin/auth";
import { monthKey, monthlyStatement } from "@/lib/nbfc/charging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function assertAdmin(role: string) {
  if (!(ADMIN_ROLES as readonly string[]).includes(role)) throw new Error("FORBIDDEN: not an admin");
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ nbfcId: string }> }) {
  try {
    const actor = await resolveAdminActor(req.headers);
    assertAdmin(actor.role);
    const { nbfcId: nbfcIdParam } = await params;
    const nbfcId = Number(nbfcIdParam);
    if (!Number.isFinite(nbfcId)) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid nbfc id" }, { status: 400 });
    }
    const [row] = await db
      .select({ tenant_id: nbfc.tenant_id, short_name: nbfc.short_name, legal_name: nbfc.legal_name })
      .from(nbfc)
      .where(eq(nbfc.id, nbfcId))
      .limit(1);
    if (!row?.tenant_id) {
      return NextResponse.json({ ok: false, error: "NOT_FOUND: nbfc or tenant not found" }, { status: 404 });
    }

    const month = new URL(req.url).searchParams.get("month") || monthKey();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: month must be YYYY-MM" }, { status: 400 });
    }

    const statement = await monthlyStatement(row.tenant_id, month);
    return NextResponse.json({
      ok: true,
      nbfc: { id: nbfcId, short_name: row.short_name, legal_name: row.legal_name },
      ...statement,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
