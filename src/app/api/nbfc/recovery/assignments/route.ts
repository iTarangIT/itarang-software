/**
 * E-262 — GET  /api/nbfc/recovery/assignments?loan_sanction_id=… — the live
 *              attempt for one loan, with its photographs and auto-flags.
 *         POST /api/nbfc/recovery/assignments — dispatch an agent.
 *
 * The POST returns 200 with `dispatch_ok: false` rather than an error status
 * when the row was written but the link could not be sent. That distinction is
 * the whole reason `assigned` and `in_progress` are separate states: the
 * assignment exists, the coordinator needs to know the agent has not heard, and
 * Resend is one click away. A 5xx here would suggest nothing happened, which
 * would be a lie.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { publicOrigin } from "@/lib/public-origin";
import {
  assignRecoveryAgent,
  computeRecoveryAutoFlags,
  getCurrentAssignment,
  listAssignmentPhotos,
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

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    if (!actor.can("recovery.view_queue")) {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot view the recovery queue` },
        { status: 403 },
      );
    }
    const loanId = req.nextUrl.searchParams.get("loan_sanction_id");
    if (!loanId) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: loan_sanction_id is required" },
        { status: 400 },
      );
    }

    const assignment = await getCurrentAssignment(actor.tenant_id, loanId);
    if (!assignment) return NextResponse.json({ ok: true, assignment: null, photos: [] });

    const photos = await listAssignmentPhotos(assignment.id);
    return NextResponse.json({
      ok: true,
      assignment,
      photos,
      auto_flags: computeRecoveryAutoFlags(assignment, photos),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}

const AssignBody = z
  .object({
    loan_sanction_id: z.string().min(1).max(255),
    agent_id: z.string().uuid(),
    due_at: z.string().datetime().optional().nullable(),
    channel: z.enum(RECOVERY_CHANNELS).optional(),
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    if (!actor.can("recovery.assign_agent")) {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot assign a recovery agent` },
        { status: 403 },
      );
    }

    const parsed = AssignBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    // NOT req.nextUrl.origin — that resolves to the internal bind host, and an
    // agent who receives a localhost link gets ERR_CONNECTION_REFUSED on a
    // doorstep. This was already a bug once in the FI flow.
    const origin = publicOrigin({ req });

    const result = await assignRecoveryAgent({
      tenant_id: actor.tenant_id,
      actor_user_id: actor.user_id ?? null,
      loan_sanction_id: parsed.data.loan_sanction_id,
      agent_id: parsed.data.agent_id,
      due_at: parsed.data.due_at ? new Date(parsed.data.due_at) : null,
      channel: parsed.data.channel,
      origin,
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
