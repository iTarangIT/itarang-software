/**
 * E-089 — GET /api/nbfc/actions/pii-access/grants?approval_request_id=...
 *
 * After the dual-approval flow lands at status='approved', the requestor
 * polls this endpoint to retrieve the time-boxed access_token. The grant is
 * lazy-minted on first poll (idempotent — repeat calls return the same row).
 *
 * Only the original requestor (initiator_user_id) may fetch the access_token.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { mintGrantIfApproved } from "@/lib/nbfc/pii-access/service";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { dualApprovalRequests } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Query = z.object({
  approval_request_id: z.string().uuid(),
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
    const url = new URL(req.url);
    const parsed = Query.safeParse({
      approval_request_id: url.searchParams.get("approval_request_id") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    // Verify the requestor owns the underlying dual-approval row.
    const dualRows = await db
      .select()
      .from(dualApprovalRequests)
      .where(eq(dualApprovalRequests.id, parsed.data.approval_request_id))
      .limit(1);
    if (dualRows.length === 0) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: approval request not found" },
        { status: 404 },
      );
    }
    const dual = dualRows[0];
    if (dual.initiator_user_id !== actor.user_id) {
      return NextResponse.json(
        { ok: false, error: "FORBIDDEN: only the requestor may fetch the grant" },
        { status: 403 },
      );
    }

    const grant = await mintGrantIfApproved(parsed.data.approval_request_id);
    if (!grant) {
      return NextResponse.json(
        {
          ok: false,
          error: "PENDING: approval not yet granted",
          status: dual.status,
        },
        { status: 409 },
      );
    }

    return NextResponse.json(
      {
        id: grant.id,
        approval_request_id: grant.approval_request_id,
        lead_id: grant.lead_id,
        access_token: grant.access_token,
        granted_at: grant.granted_at,
        expires_at: grant.expires_at,
        used_count: grant.used_count,
        fields: grant.fields,
      },
      { status: 200 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
