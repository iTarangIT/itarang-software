/**
 * PATCH  /api/nbfc/fi/agents/[agentId] — edit an FI agent (§10.5).
 * DELETE /api/nbfc/fi/agents/[agentId] — deactivate (soft) — agents are
 *                                        referenced by past attempts.
 *
 * Role: fi_coordinator / nbfc_admin. Tenant-scoped (a foreign agentId 404s).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { deactivateFiAgent, updateFiAgent } from "@/lib/nbfc/fi-agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  return 500;
}

function canManage(role: string): boolean {
  return role === "fi_coordinator" || role === "nbfc_admin";
}

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  phone: z.string().min(4).max(20).optional(),
  email: z.string().email().max(200).optional().or(z.literal("")),
  city: z.string().max(120).optional().or(z.literal("")),
  preferred_channel: z.enum(["email", "sms", "whatsapp"]).optional(),
  reference_photo_url: z.string().max(2048).optional().or(z.literal("")),
  active: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const { agentId } = await params;
    const actor = await resolveActor(req.headers);
    if (!canManage(actor.role)) {
      return NextResponse.json({ ok: false, error: `FORBIDDEN: role '${actor.role}' cannot manage FI agents` }, { status: 403 });
    }
    const parsed = PatchBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "VALIDATION", issues: parsed.error.issues }, { status: 400 });
    }
    const agent = await updateFiAgent(agentId, actor.tenant_id, parsed.data);
    if (!agent) return NextResponse.json({ ok: false, error: "Agent not found" }, { status: 404 });
    return NextResponse.json({ ok: true, agent });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const { agentId } = await params;
    const actor = await resolveActor(req.headers);
    if (!canManage(actor.role)) {
      return NextResponse.json({ ok: false, error: `FORBIDDEN: role '${actor.role}' cannot manage FI agents` }, { status: 403 });
    }
    const agent = await deactivateFiAgent(agentId, actor.tenant_id);
    if (!agent) return NextResponse.json({ ok: false, error: "Agent not found" }, { status: 404 });
    return NextResponse.json({ ok: true, agent });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
