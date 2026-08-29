/**
 * E-262 — PATCH  /api/nbfc/recovery/agents/[agentId] — edit an agent.
 *         DELETE /api/nbfc/recovery/agents/[agentId] — DEACTIVATE (soft).
 *
 * The delete is a deactivation, not a removal: past assignments name the agent
 * who did the job, and a collection nobody can attribute is not much of an
 * audit trail. Deactivating takes them out of the assign picker, which is the
 * only thing anyone actually wants when they click it.
 *
 * Tenant-scoped — an agentId belonging to another NBFC 404s rather than 403s,
 * so the route never confirms that somebody else's agent exists.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import {
  deactivateRecoveryAgent,
  updateRecoveryAgent,
  RECOVERY_CHANNELS,
} from "@/lib/nbfc/recovery/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

const PatchBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  phone: z.string().trim().min(4).max(20).optional(),
  email: z.string().trim().email().max(200).optional().or(z.literal("")),
  city: z.string().trim().max(120).optional().or(z.literal("")),
  coverage_area: z.string().trim().max(500).optional().or(z.literal("")),
  preferred_channel: z.enum(RECOVERY_CHANNELS).optional(),
  reference_photo_url: z.string().trim().max(2048).optional().or(z.literal("")),
  active: z.boolean().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { agentId } = await params;
    const actor = await resolveActor(req.headers);
    if (!actor.can("recovery.manage_agents")) {
      return NextResponse.json(
        {
          ok: false,
          error: `FORBIDDEN: role '${actor.role}' cannot manage recovery agents`,
        },
        { status: 403 },
      );
    }

    const parsed = PatchBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const agent = await updateRecoveryAgent(agentId, actor.tenant_id, parsed.data);
    if (!agent) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: agent not found" },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, agent });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { agentId } = await params;
    const actor = await resolveActor(req.headers);
    if (!actor.can("recovery.manage_agents")) {
      return NextResponse.json(
        {
          ok: false,
          error: `FORBIDDEN: role '${actor.role}' cannot manage recovery agents`,
        },
        { status: 403 },
      );
    }

    const agent = await deactivateRecoveryAgent(agentId, actor.tenant_id);
    if (!agent) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: agent not found" },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, agent });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
