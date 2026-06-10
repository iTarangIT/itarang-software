/**
 * GET/PUT /api/nbfc/settings/wallet
 *
 * §8.1 — the NBFC's view of its prepaid wallet: balance, recent transaction
 * history, and the auto-NACH recharge config (the NBFC sets the trigger
 * threshold + recharge amount). GET is open to any tenant member; PUT
 * (auto-NACH config) requires nbfc_admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcWallets, nbfcWalletLedger } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getOrCreateWallet } from "@/lib/nbfc/charging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

const Body = z.object({
  auto_nach_enabled: z.boolean(),
  auto_nach_threshold: z.union([z.number(), z.string()]).nullable().optional(),
  auto_nach_recharge_amount: z.union([z.number(), z.string()]).nullable().optional(),
});

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    const wallet = await getOrCreateWallet(actor.tenant_id);
    const ledger = await db
      .select()
      .from(nbfcWalletLedger)
      .where(eq(nbfcWalletLedger.tenant_id, actor.tenant_id))
      .orderBy(desc(nbfcWalletLedger.created_at))
      .limit(50);
    return NextResponse.json({ ok: true, wallet, ledger });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}

export async function PUT(req: NextRequest) {
  try {
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
    const actor = await resolveActor(req.headers);
    if (actor.role !== "nbfc_admin") {
      return NextResponse.json({ ok: false, error: `FORBIDDEN: nbfc_admin required (role '${actor.role}')` }, { status: 403 });
    }
    const d = parsed.data;
    if (d.auto_nach_enabled && (d.auto_nach_threshold == null || d.auto_nach_recharge_amount == null)) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: threshold and recharge amount required when auto-NACH is enabled" },
        { status: 400 },
      );
    }
    await getOrCreateWallet(actor.tenant_id);
    await db
      .update(nbfcWallets)
      .set({
        auto_nach_enabled: d.auto_nach_enabled,
        auto_nach_threshold: d.auto_nach_threshold == null ? null : String(d.auto_nach_threshold),
        auto_nach_recharge_amount: d.auto_nach_recharge_amount == null ? null : String(d.auto_nach_recharge_amount),
        updated_at: new Date(),
      })
      .where(eq(nbfcWallets.tenant_id, actor.tenant_id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
