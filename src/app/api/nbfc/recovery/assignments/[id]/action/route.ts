/**
 * E-262 — POST /api/nbfc/recovery/assignments/[id]/action
 *
 * Everything the NBFC does to a live assignment after dispatching it, behind
 * one discriminated body:
 *
 *   resend_link  re-mints the token and sends it again, on a NEW window
 *   cancel       stands the agent down and emails "do not collect"
 *   review       approve (stamps the battery master) or reject
 *   reassign     cancels this attempt, emails the outgoing agent, opens the next
 *
 * Modelled on `/api/nbfc/fi/[leadId]/action`. Each action carries its own
 * permission because they are genuinely different authorities: a risk manager
 * can send an agent out and call them back, but approving a collection writes
 * to the asset register and hands the battery to inspection.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { publicOrigin } from "@/lib/public-origin";
import {
  cancelRecoveryAssignment,
  getAssignment,
  reassignRecoveryAgent,
  resendRecoveryLink,
  reviewRecoveryAssignment,
} from "@/lib/nbfc/recovery/assignment";
import { RECOVERY_CHANNELS } from "@/lib/nbfc/recovery/agents";

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

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("resend_link"),
    channel: z.enum(RECOVERY_CHANNELS).optional(),
  }),
  z.object({
    action: z.literal("cancel"),
    // A cancellation email tells an agent to abandon a job they may already be
    // driving to. "Why" is the least the record should carry.
    reason: z.string().trim().min(3).max(500),
  }),
  z.object({
    action: z.literal("review"),
    decision: z.enum(["approve", "reject"]),
    notes: z.string().trim().max(1000).optional().nullable(),
    promote_photo_urls: z.array(z.string()).max(20).optional(),
  }),
  z.object({
    action: z.literal("reassign"),
    agent_id: z.string().uuid(),
    reason: z.string().trim().min(3).max(500),
    due_at: z.string().datetime().optional().nullable(),
    channel: z.enum(RECOVERY_CHANNELS).optional(),
  }),
]);

/** Which permission each action needs. */
const PERMISSION: Record<string, string> = {
  resend_link: "recovery.assign_agent",
  cancel: "recovery.cancel",
  review: "recovery.review",
  reassign: "recovery.assign_agent",
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const actor = await resolveActor(req.headers);

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const d = parsed.data;

    const needed = PERMISSION[d.action];
    if (!actor.can(needed)) {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot ${d.action.replace("_", " ")}` },
        { status: 403 },
      );
    }

    // Resolved once, tenant-scoped, so a foreign assignment id 404s here rather
    // than in each branch.
    const existing = await getAssignment(actor.tenant_id, id);
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: assignment not found" },
        { status: 404 },
      );
    }

    if (d.action === "resend_link") {
      const result = await resendRecoveryLink({
        tenant_id: actor.tenant_id,
        actor_user_id: actor.user_id ?? null,
        assignment_id: id,
        channel: d.channel,
        origin: publicOrigin({ req }),
      });
      return NextResponse.json({ ok: true, ...result });
    }

    if (d.action === "cancel") {
      const result = await cancelRecoveryAssignment({
        tenant_id: actor.tenant_id,
        actor_user_id: actor.user_id ?? null,
        assignment_id: id,
        reason: d.reason,
        source: "manual",
      });
      if (!result.cancelled) {
        return NextResponse.json(
          {
            ok: false,
            error: `CONFLICT: this assignment is ${result.assignment?.status ?? "gone"} and cannot be cancelled`,
          },
          { status: 409 },
        );
      }
      return NextResponse.json({ ok: true, ...result });
    }

    if (d.action === "review") {
      const result = await reviewRecoveryAssignment({
        tenant_id: actor.tenant_id,
        actor_user_id: actor.user_id ?? null,
        assignment_id: id,
        decision: d.decision,
        notes: d.notes ?? null,
        promote_photo_urls: d.promote_photo_urls,
      });
      return NextResponse.json({ ok: true, ...result });
    }

    // reassign
    const result = await reassignRecoveryAgent({
      tenant_id: actor.tenant_id,
      actor_user_id: actor.user_id ?? null,
      loan_sanction_id: existing.loan_sanction_id,
      agent_id: d.agent_id,
      reason: d.reason,
      due_at: d.due_at ? new Date(d.due_at) : null,
      channel: d.channel,
      origin: publicOrigin({ req }),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
