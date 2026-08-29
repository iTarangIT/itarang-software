/**
 * E-262 — GET  /api/nbfc/recovery/agents — this NBFC's recovery agent directory.
 *         POST /api/nbfc/recovery/agents — add an agent.
 *
 * Gated on `recovery.manage_agents` for writes. Reads are open to anyone who
 * can see the Recovery queue, because the assign picker needs the list and a
 * coordinator who cannot edit the directory can still dispatch from it.
 *
 * `?active=1` narrows to agents who are still working — what the picker wants.
 * The Settings screen asks for everyone, so a deactivated agent can be brought
 * back rather than re-typed.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";

import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import {
  createRecoveryAgent,
  listRecoveryAgents,
  RECOVERY_CHANNELS,
} from "@/lib/nbfc/recovery/agents";
import { db } from "@/lib/db";
import { nbfc, nbfcLeadAssignments } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

/**
 * This tenant's legacy integer NBFC id, kept on the agent row for parity with
 * `nbfc_fi_agents`. Canonical mapping is `nbfc.tenant_id` (the E-026B bridge);
 * older tenants whose nbfc row predates the bridge are found through any lead
 * assignment. Unlike the FI route this is NOT fatal when it comes back null —
 * the column is nullable and nothing reads it, so a tenant that predates the
 * bridge can still keep a recovery directory.
 */
async function resolveNbfcId(tenantId: string): Promise<number | null> {
  const [byBridge] = await db
    .select({ id: nbfc.id })
    .from(nbfc)
    .where(eq(nbfc.tenant_id, tenantId))
    .orderBy(desc(nbfc.id))
    .limit(1);
  if (byBridge?.id != null) return byBridge.id;
  const [byAssignment] = await db
    .select({ nbfc_id: nbfcLeadAssignments.nbfc_id })
    .from(nbfcLeadAssignments)
    .where(eq(nbfcLeadAssignments.tenant_id, tenantId))
    .limit(1);
  return byAssignment?.nbfc_id ?? null;
}

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    const activeOnly = req.nextUrl.searchParams.get("active") === "1";
    const agents = await listRecoveryAgents(actor.tenant_id, { activeOnly });
    return NextResponse.json({
      ok: true,
      agents,
      can_manage: actor.can("recovery.manage_agents"),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}

const CreateBody = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(4).max(20),
  email: z.string().trim().email().max(200).optional().or(z.literal("")),
  city: z.string().trim().max(120).optional().or(z.literal("")),
  coverage_area: z.string().trim().max(500).optional().or(z.literal("")),
  preferred_channel: z.enum(RECOVERY_CHANNELS).optional(),
  reference_photo_url: z.string().trim().max(2048).optional().or(z.literal("")),
});

export async function POST(req: NextRequest) {
  try {
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

    const parsed = CreateBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    // An agent with neither email nor a usable phone cannot be sent a link, and
    // an agent who cannot be sent a link cannot be dispatched. Better to say so
    // at the point of typing than at the point of assigning, three screens away.
    if (
      parsed.data.preferred_channel === "email" &&
      !parsed.data.email
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "BAD_REQUEST: an email address is required when the preferred channel is email",
        },
        { status: 400 },
      );
    }

    const agent = await createRecoveryAgent(
      actor.tenant_id,
      await resolveNbfcId(actor.tenant_id),
      {
        name: parsed.data.name,
        phone: parsed.data.phone,
        email: parsed.data.email || null,
        city: parsed.data.city || null,
        coverage_area: parsed.data.coverage_area || null,
        preferred_channel: parsed.data.preferred_channel,
        reference_photo_url: parsed.data.reference_photo_url || null,
      },
    );
    return NextResponse.json({ ok: true, agent }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
