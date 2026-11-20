/**
 * E-387 — route-side gate for the parent / child CIBIL approval hierarchy.
 *
 * Usage, right after `resolveActor` in an Acquire action route:
 *
 *   const blocked = await hierarchyBlock(actor, leadId, "fi");
 *   if (blocked) return blocked;
 *
 * Returns a 403 in the route's own JSON shape, or null when the step is allowed.
 * The KYC card routes speak `{ success, error: { message } }`; the rest speak
 * `{ ok, error }`.
 */
import { NextResponse } from "next/server";
import { decideStep, getHierarchyContext, type GatedStep } from "./approval-hierarchy";

export async function hierarchyBlock(
  actor: { tenant_id: string; user_id: string },
  leadId: string,
  step: GatedStep,
  shape: "ok" | "success" = "ok",
): Promise<NextResponse | null> {
  const ctx = await getHierarchyContext(actor.tenant_id, actor.user_id, leadId);
  const d = decideStep(ctx, step);
  if (d.ok) return null;
  const message = `FORBIDDEN: ${d.reason}`;
  return shape === "success"
    ? NextResponse.json({ success: false, error: { message: d.reason } }, { status: 403 })
    : NextResponse.json({ ok: false, error: message, code: "HIERARCHY_LOCKED" }, { status: 403 });
}
