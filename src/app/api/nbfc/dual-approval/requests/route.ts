/**
 * E-082 — Dual Approval Gate
 *
 * GET  /api/nbfc/dual-approval/requests           — list requests (tenant-scoped)
 * POST /api/nbfc/dual-approval/requests           — create a pending request
 *
 * AuthN/Z: getCurrentTenant + requireNbfcAccess (canonical NBFC route idiom),
 * with a triple-guarded test bypass for the self-coding loop's API tests.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { and, eq, desc } from "drizzle-orm";
import { dualApprovalRequests } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { createDualApprovalRequest } from "@/lib/nbfc/dual-approval/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTION_TYPES = [
  "battery_immobilisation",
  "loan_restructuring",
  "risk_rule_threshold_change",
  "bulk_immobilisation",
  "auction_lot_cancellation",
  "audit_log_export",
  "pii_data_access",
] as const;

const CreateBody = z.object({
  action_type: z.enum(ACTION_TYPES),
  entity_id: z.string().min(1),
  reason_code: z.string().min(1),
  evidence_snapshot: z.record(z.string(), z.unknown()),
  borrower_notice_id: z.string().optional(),
  reviewed_evidence_ack: z.literal(true),
});

const ListQuery = z.object({
  status: z
    .enum(["pending_approval", "approved", "rejected", "expired"])
    .optional(),
  action_type: z.string().optional(),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }
    const parsed = CreateBody.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: "VALIDATION",
          issues: parsed.error.issues,
        },
        { status: 400 },
      );
    }
    const row = await createDualApprovalRequest({
      tenant_id: actor.tenant_id,
      initiator_user_id: actor.user_id,
      action_type: parsed.data.action_type,
      entity_id: parsed.data.entity_id,
      reason_code: parsed.data.reason_code,
      evidence_snapshot: parsed.data.evidence_snapshot,
      borrower_notice_id: parsed.data.borrower_notice_id ?? null,
    });
    return NextResponse.json(
      {
        id: row.id,
        status: row.status,
        action_type: row.action_type,
        entity_id: row.entity_id,
        initiator_user_id: row.initiator_user_id,
        required_approver_role: row.required_approver_role,
        reason_code: row.reason_code,
        evidence_snapshot: row.evidence_snapshot,
        borrower_notice_id: row.borrower_notice_id,
        created_at: row.created_at,
        expires_at: row.expires_at,
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

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    const url = new URL(req.url);
    const parsed = ListQuery.safeParse({
      status: url.searchParams.get("status") ?? undefined,
      action_type: url.searchParams.get("action_type") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const filters = [eq(dualApprovalRequests.tenant_id, actor.tenant_id)];
    if (parsed.data.status) {
      filters.push(eq(dualApprovalRequests.status, parsed.data.status));
    }
    if (parsed.data.action_type) {
      filters.push(eq(dualApprovalRequests.action_type, parsed.data.action_type));
    }
    const rows = await db
      .select()
      .from(dualApprovalRequests)
      .where(and(...filters))
      .orderBy(desc(dualApprovalRequests.created_at))
      .limit(200);
    return NextResponse.json({ items: rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
