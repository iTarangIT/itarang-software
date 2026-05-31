/**
 * PUT/DELETE /api/admin/nbfc/[id]/charges/[chargeId]
 *
 * §8.2 — edit or remove a chargeable-item catalogue entry. Admin-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcChargeCatalogue } from "@/lib/db/schema";
import { resolveAdminActor, statusFromError, ADMIN_ROLES } from "@/lib/nbfc/admin/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function assertAdmin(role: string) {
  if (!(ADMIN_ROLES as readonly string[]).includes(role)) throw new Error("FORBIDDEN: not an admin");
}

const Body = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  type: z.enum(["service_usage", "platform_fee", "disbursal_fee", "other"]).optional(),
  amount: z.union([z.number(), z.string()]).transform((v) => Number(v)).pipe(z.number().nonnegative()).optional(),
  trigger: z.enum(["on_api_execution", "on_vkyc_run", "on_disbursal", "monthly", "manual"]).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  commercial_doc_url: z.string().max(2048).nullable().optional(),
});

export async function PUT(req: NextRequest, { params }: { params: Promise<{ nbfcId: string; chargeId: string }> }) {
  try {
    const actor = await resolveAdminActor(req.headers);
    assertAdmin(actor.role);
    const { chargeId } = await params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "VALIDATION", issues: parsed.error.issues }, { status: 400 });
    }
    const d = parsed.data;
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (d.name !== undefined) set.name = d.name;
    if (d.type !== undefined) set.type = d.type;
    if (d.amount !== undefined) set.amount = String(d.amount);
    if (d.trigger !== undefined) set.trigger = d.trigger;
    if (d.status !== undefined) set.status = d.status;
    if (d.commercial_doc_url !== undefined) set.commercial_doc_url = d.commercial_doc_url;

    await db.update(nbfcChargeCatalogue).set(set).where(eq(nbfcChargeCatalogue.id, chargeId));
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ nbfcId: string; chargeId: string }> }) {
  try {
    const actor = await resolveAdminActor(req.headers);
    assertAdmin(actor.role);
    const { chargeId } = await params;
    await db.delete(nbfcChargeCatalogue).where(eq(nbfcChargeCatalogue.id, chargeId));
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
