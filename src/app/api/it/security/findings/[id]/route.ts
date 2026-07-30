/**
 * Manual triage of a finding (Acknowledge / Mark Resolved / False Positive /
 * Reopen).
 *
 * Beyond flipping the status this records the resolution audit trail (E-219):
 * every action appends a security_finding_actions row with the actor and the
 * request origin (IP + user-agent), and a resolve/false-positive also fills the
 * denormalised resolution_* columns so the History tab can show "resolved
 * manually by X from IP Y" without a join. A Reopen clears those columns but
 * leaves the audit rows in place — the history is append-only.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { securityFindings, securityFindingMessages } from "@/lib/db/schema";
import { requireSecurityAdmin } from "@/lib/security/route-guard";
import { recordFindingAction, requestOrigin, type FindingActionKind } from "@/lib/security/resolution-audit";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  status: z.enum(["open", "acknowledged", "resolved", "false_positive"]),
  // Optional free-text reason the human typed — becomes the resolution summary.
  note: z.string().trim().max(2000).optional(),
});

const ACTION_FOR_STATUS: Record<string, FindingActionKind> = {
  open: "reopened",
  acknowledged: "acknowledged",
  resolved: "resolved",
  false_positive: "false_positive",
};

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSecurityAdmin();
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid status" }, { status: 400 });
  }
  const { status, note } = parsed.data;

  const [before] = await db
    .select({ status: securityFindings.status, title: securityFindings.title })
    .from(securityFindings)
    .where(eq(securityFindings.id, id))
    .limit(1);
  if (!before) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  const origin = requestOrigin(req);
  const actorLabel = auth.user.email ?? auth.user.id;
  const now = new Date();
  const closing = status === "resolved" || status === "false_positive";
  const reopening = status === "open";

  const summary = closing
    ? note ||
      (status === "resolved"
        ? `Marked resolved manually by ${actorLabel}.`
        : `Marked a false positive by ${actorLabel}.`)
    : null;

  const report = closing
    ? {
        method: "manual" as const,
        applied: false,
        verified: false,
        resolved_at: now.toISOString(),
        resolved_by: actorLabel,
        resolved_from_ip: origin.ip,
        user_agent: origin.userAgent,
        previous_status: before.status,
        note: note ?? null,
        explanation: summary,
      }
    : null;

  const [row] = await db
    .update(securityFindings)
    .set({
      status,
      acknowledged_at: status === "acknowledged" ? now : reopening ? null : undefined,
      resolved_at: closing ? now : reopening ? null : undefined,
      // Resolution bookkeeping: set on close, cleared on reopen, untouched otherwise.
      resolution_method: closing ? "manual" : reopening ? null : undefined,
      resolution_summary: closing ? summary : reopening ? null : undefined,
      resolution_report: closing ? report : reopening ? null : undefined,
      resolved_by: closing ? auth.user.id : reopening ? null : undefined,
      resolved_by_email: closing ? auth.user.email : reopening ? null : undefined,
      resolved_ip: closing ? origin.ip : reopening ? null : undefined,
      resolved_user_agent: closing ? origin.userAgent : reopening ? null : undefined,
    })
    .where(eq(securityFindings.id, id))
    .returning({ id: securityFindings.id, status: securityFindings.status });

  if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  const action = ACTION_FOR_STATUS[status];
  await recordFindingAction({
    findingId: id,
    action,
    method: closing ? "manual" : null,
    actor: auth.user,
    origin,
    summary:
      summary ??
      (status === "acknowledged"
        ? `Acknowledged by ${actorLabel}.`
        : `Reopened by ${actorLabel} (was ${before.status.replace("_", " ")}).`),
    detail: { previous_status: before.status, note: note ?? null },
  });

  // Mirror closes into the conversation so the chat transcript stays the single
  // narrative of how the finding was dealt with.
  if (closing) {
    await db
      .insert(securityFindingMessages)
      .values({
        finding_id: id,
        role: "system",
        message: `${status === "resolved" ? "Marked resolved" : "Marked a false positive"} manually by ${actorLabel} from IP ${origin.ip ?? "unknown"}.${note ? ` Note: ${note}` : ""}`,
      })
      .catch(() => {});
  }

  return NextResponse.json({ ok: true, id: row.id, status: row.status });
}
