/**
 * E-089 — GET /api/nbfc/pii/unmask?lead_id=...&access_token=...
 *
 * Returns full unmasked aadhaar/pan for the lead bound to the grant.
 *
 * Behaviour:
 *   - Lazy-mints the grant if the underlying dual_approval_requests row is
 *     'approved' but no nbfc_pii_access_grants row exists yet (idempotent).
 *     This decouples this endpoint from any side-effect inside E-082.
 *   - Verifies access_token + lead_id + actor (requestor must match
 *     dual_approval_requests.initiator_user_id), and refuses if the grant
 *     has expired.
 *   - Increments used_count and writes audit_logs (action='pii_access.viewed').
 *
 * AuthN/Z: resolveActor (NBFC route idiom + bypass for tests).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { dualApprovalRequests, nbfcPiiAccessGrants } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import {
  mintGrantIfApproved,
  unmaskWithGrant,
} from "@/lib/nbfc/pii-access/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Query = z.object({
  lead_id: z.string().min(1),
  access_token: z.string().min(8).optional(),
  approval_request_id: z.string().uuid().optional(),
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
      lead_id: url.searchParams.get("lead_id") ?? undefined,
      access_token: url.searchParams.get("access_token") ?? undefined,
      approval_request_id:
        url.searchParams.get("approval_request_id") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    let accessToken = parsed.data.access_token;

    // If the caller doesn't yet have an access_token, allow them to pass
    // approval_request_id and we'll lazy-mint the grant on first call.
    if (!accessToken && parsed.data.approval_request_id) {
      const grant = await mintGrantIfApproved(parsed.data.approval_request_id);
      if (!grant) {
        return NextResponse.json(
          { ok: false, error: "FORBIDDEN: approval not yet granted" },
          { status: 403 },
        );
      }
      accessToken = grant.access_token;
    }

    if (!accessToken) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: access_token or approval_request_id required" },
        { status: 400 },
      );
    }

    // Defence in depth: if the grant exists but the underlying dual-approval
    // row has flipped to 'approved' between mint and now, no-op (the grant
    // captured the approval-time state). If the dual row has been moved out
    // of 'approved' (e.g. by some operator), the grant still controls.

    const result = await unmaskWithGrant({
      lead_id: parsed.data.lead_id,
      access_token: accessToken,
      user_id: actor.user_id,
    });

    return NextResponse.json(
      {
        aadhaar: result.aadhaar,
        pan: result.pan,
        expires_at: result.expires_at,
        used_count: result.used_count,
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

// Mark imports used — not all branches of the GET hit them every time.
void dualApprovalRequests;
void nbfcPiiAccessGrants;
void eq;
