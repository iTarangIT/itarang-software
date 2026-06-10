/**
 * GET/POST /api/admin/nbfc/[id]/charges
 *
 * BRD Addendum V0.2 §8.2 — the iTarang-admin-maintained chargeable-item
 * catalogue for an NBFC. [id] is the nbfc.id; charges are stored against its
 * tenant_id. GET lists this tenant's items + global defaults; POST creates an
 * item. Admin-only (iTarang admin configures; the NBFC is the billing party).
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { and, eq, isNull, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfc, nbfcChargeCatalogue } from "@/lib/db/schema";
import { resolveAdminActor, statusFromError, ADMIN_ROLES } from "@/lib/nbfc/admin/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function assertAdmin(role: string) {
  if (!(ADMIN_ROLES as readonly string[]).includes(role)) throw new Error("FORBIDDEN: not an admin");
}

async function tenantForNbfc(idParam: string): Promise<string> {
  const nbfcId = Number(idParam);
  if (!Number.isFinite(nbfcId)) throw new Error("BAD_REQUEST: invalid nbfc id");
  const [row] = await db.select({ tenant_id: nbfc.tenant_id }).from(nbfc).where(eq(nbfc.id, nbfcId)).limit(1);
  if (!row?.tenant_id) throw new Error("NOT_FOUND: nbfc or tenant not found");
  return row.tenant_id;
}

const Body = z.object({
  name: z.string().trim().min(2).max(160),
  type: z.enum(["service_usage", "platform_fee", "disbursal_fee", "other"]),
  amount: z.union([z.number(), z.string()]).transform((v) => Number(v)).pipe(z.number().nonnegative()),
  trigger: z.enum(["on_api_execution", "on_vkyc_run", "on_disbursal", "monthly", "manual"]),
  status: z.enum(["active", "inactive"]).default("active"),
  commercial_doc_url: z.string().max(2048).nullable().optional(),
  global: z.boolean().optional(), // true → tenant_id NULL (applies to all NBFCs)
});

export async function GET(req: NextRequest, { params }: { params: Promise<{ nbfcId: string }> }) {
  try {
    const actor = await resolveAdminActor(req.headers);
    assertAdmin(actor.role);
    const { nbfcId } = await params;
    const tenantId = await tenantForNbfc(nbfcId);
    const items = await db
      .select()
      .from(nbfcChargeCatalogue)
      .where(or(eq(nbfcChargeCatalogue.tenant_id, tenantId), isNull(nbfcChargeCatalogue.tenant_id)));
    return NextResponse.json({ ok: true, items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ nbfcId: string }> }) {
  try {
    const actor = await resolveAdminActor(req.headers);
    assertAdmin(actor.role);
    const { nbfcId } = await params;
    const tenantId = await tenantForNbfc(nbfcId);

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
    const [created] = await db
      .insert(nbfcChargeCatalogue)
      .values({
        tenant_id: d.global ? null : tenantId,
        name: d.name,
        type: d.type,
        amount: String(d.amount),
        trigger: d.trigger,
        status: d.status,
        commercial_doc_url: d.commercial_doc_url ?? null,
        updated_at: new Date(),
      })
      .returning({ id: nbfcChargeCatalogue.id });
    return NextResponse.json({ ok: true, id: created.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
