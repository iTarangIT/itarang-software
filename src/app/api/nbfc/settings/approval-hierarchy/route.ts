/**
 * PUT /api/nbfc/settings/approval-hierarchy   body { cibil_required: boolean }
 *
 * E-387 — the tenant switch "CIBIL approval required before any other step".
 * Turning it on stamps nbfc_tenants.cibil_review_enabled_at = now(); the gate
 * then applies to leads assigned from that moment, so files already in flight
 * keep moving. Turning it off clears the stamp. Caller must hold `users.manage`.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcAuditLog, nbfcTenants } from "@/lib/db/schema";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ cibil_required: z.boolean() });

export async function PUT(req: Request) {
  try {
    const actor = await resolveActor(req.headers);
    if (!actor.can("users.manage")) {
      return NextResponse.json({ ok: false, error: "FORBIDDEN: users.manage required" }, { status: 403 });
    }
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

    const [t] = await db
      .select({ enabledAt: nbfcTenants.cibil_review_enabled_at })
      .from(nbfcTenants)
      .where(eq(nbfcTenants.id, actor.tenant_id))
      .limit(1);
    const now = new Date();
    // Keep the original stamp when it is already on (re-saving must not
    // un-gate leads assigned in between).
    const next = parsed.data.cibil_required ? (t?.enabledAt ?? now) : null;
    if ((t?.enabledAt?.getTime() ?? null) !== (next?.getTime() ?? null)) {
      await db
        .update(nbfcTenants)
        .set({ cibil_review_enabled_at: next, updated_at: now })
        .where(eq(nbfcTenants.id, actor.tenant_id));
      await db.insert(nbfcAuditLog).values({
        tenant_id: actor.tenant_id,
        user_id: actor.user_id,
        action_type: "cibil_gate_changed",
        action_id: null,
        before_state: { cibil_review_enabled_at: t?.enabledAt?.toISOString() ?? null },
        after_state: { cibil_review_enabled_at: next?.toISOString() ?? null },
        created_at: now,
      });
    }
    return NextResponse.json({ ok: true, cibil_review_enabled_at: next?.toISOString() ?? null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("UNAUTHORIZED") ? 401 : msg.startsWith("FORBIDDEN") ? 403 : 500;
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status });
  }
}
