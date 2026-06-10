/**
 * GET  /api/nbfc/fi/agents — list this NBFC's FI agent directory (§10.5).
 * POST /api/nbfc/fi/agents — add an agent.
 *
 * Role: fi_coordinator / nbfc_admin. Tenant-scoped throughout.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";

import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { createFiAgent, listFiAgents } from "@/lib/nbfc/fi-agents";
import { db } from "@/lib/db";
import { nbfc, nbfcLeadAssignments } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

function canManage(role: string): boolean {
  return role === "fi_coordinator" || role === "nbfc_admin";
}

/**
 * Resolve this tenant's legacy NBFC id (the integer FI rows are keyed by).
 * Canonical mapping is nbfc.tenant_id (E-026B bridge); fall back to any lead
 * assignment binding for older tenants whose nbfc row predates the bridge.
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
    const agents = await listFiAgents(actor.tenant_id, { activeOnly });
    return NextResponse.json({ ok: true, agents, can_manage: canManage(actor.role) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().min(4).max(20),
  email: z.string().email().max(200).optional().or(z.literal("")),
  city: z.string().max(120).optional().or(z.literal("")),
  preferred_channel: z.enum(["email", "sms", "whatsapp"]).optional(),
  reference_photo_url: z.string().max(2048).optional().or(z.literal("")),
});

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    if (!canManage(actor.role)) {
      return NextResponse.json({ ok: false, error: `FORBIDDEN: role '${actor.role}' cannot manage FI agents` }, { status: 403 });
    }
    const parsed = CreateBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "VALIDATION", issues: parsed.error.issues }, { status: 400 });
    }
    const nbfcId = await resolveNbfcId(actor.tenant_id);
    if (nbfcId == null) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: could not resolve NBFC id for this tenant" }, { status: 400 });
    }
    const agent = await createFiAgent(actor.tenant_id, nbfcId, {
      name: parsed.data.name,
      phone: parsed.data.phone,
      email: parsed.data.email || null,
      city: parsed.data.city || null,
      preferred_channel: parsed.data.preferred_channel,
      reference_photo_url: parsed.data.reference_photo_url || null,
    });
    return NextResponse.json({ ok: true, agent });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
