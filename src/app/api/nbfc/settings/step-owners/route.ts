/**
 * GET/PUT /api/nbfc/settings/step-owners
 *
 * BRD Addendum V0.2 §7.2 — per-NBFC step ownership (default + city-wise).
 *
 * GET  — all step-owner rows for the current tenant.
 * PUT  — replace the tenant's full owner set (delete-then-insert in a txn).
 *        Requires the `nbfc_admin` role. city omitted/null = the step's default
 *        owner; a non-null city is a city-wise override.
 *
 * The owner must be a member of this tenant (an nbfc_users row); we do not hard
 * FK that here, but the UI only offers current members.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfcStepOwners } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OwnerRow = z.object({
  step: z.enum(["fi", "vkyc", "enach"]),
  city: z.string().trim().min(1).max(120).nullable().optional(),
  user_id: z.string().uuid(),
});

const Body = z.object({
  owners: z.array(OwnerRow).max(200),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    const rows = await db
      .select()
      .from(nbfcStepOwners)
      .where(eq(nbfcStepOwners.tenant_id, actor.tenant_id));
    return NextResponse.json({ ok: true, owners: rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
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
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const actor = await resolveActor(req.headers);
    if (actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: caller role '${actor.role}' is not authorised; nbfc_admin required` },
        { status: 403 },
      );
    }

    // Reject duplicate (step, city) within the payload before the DB unique
    // index would, so the client gets a clear message.
    const seen = new Set<string>();
    for (const o of parsed.data.owners) {
      const key = `${o.step}::${o.city ?? ""}`;
      if (seen.has(key)) {
        return NextResponse.json(
          { ok: false, error: `BAD_REQUEST: duplicate owner for step '${o.step}'${o.city ? ` city '${o.city}'` : " (default)"}` },
          { status: 400 },
        );
      }
      seen.add(key);
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.delete(nbfcStepOwners).where(eq(nbfcStepOwners.tenant_id, actor.tenant_id));
      if (parsed.data.owners.length > 0) {
        await tx.insert(nbfcStepOwners).values(
          parsed.data.owners.map((o) => ({
            tenant_id: actor.tenant_id,
            step: o.step,
            city: o.city ?? null,
            user_id: o.user_id,
            updated_at: now,
          })),
        );
      }
    });

    return NextResponse.json({ ok: true, count: parsed.data.owners.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
