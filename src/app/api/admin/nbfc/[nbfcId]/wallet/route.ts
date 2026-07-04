/**
 * GET/POST /api/admin/nbfc/[id]/wallet
 *
 * §8.1/§8.2 — admin view of an NBFC's prepaid wallet + recent ledger, and the
 * post point for manual top-ups and one-off manual deductions (the catch-all).
 * Admin-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfc, nbfcWalletLedger } from "@/lib/db/schema";
import { resolveAdminActor, statusFromError, ADMIN_ROLES } from "@/lib/nbfc/admin/auth";
import { getOrCreateWallet, postManualDeduction, postTopup } from "@/lib/nbfc/charging";

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
  action: z.enum(["topup", "manual_deduction"]),
  amount: z.union([z.number(), z.string()]).transform((v) => Number(v)).pipe(z.number().positive()),
  description: z.string().trim().min(2).max(500),
});

export async function GET(req: NextRequest, { params }: { params: Promise<{ nbfcId: string }> }) {
  try {
    const actor = await resolveAdminActor(req.headers);
    assertAdmin(actor.role);
    const { nbfcId } = await params;
    const tenantId = await tenantForNbfc(nbfcId);
    const wallet = await getOrCreateWallet(tenantId);
    const ledger = await db
      .select()
      .from(nbfcWalletLedger)
      .where(eq(nbfcWalletLedger.tenant_id, tenantId))
      .orderBy(desc(nbfcWalletLedger.created_at))
      .limit(50);
    return NextResponse.json({ ok: true, wallet, ledger });
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
    const ledgerId =
      d.action === "topup"
        ? await postTopup({ tenantId, amount: d.amount, description: d.description, postedBy: actor.user_id })
        : await postManualDeduction({ tenantId, amount: d.amount, description: d.description, postedBy: actor.user_id });
    return NextResponse.json({ ok: true, ledger_id: ledgerId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
