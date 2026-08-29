/**
 * Resolution audit trail for security findings (E-219).
 *
 * Every triage/resolution action on a finding writes one append-only row to
 * security_finding_actions, carrying the actor AND the request origin (IP +
 * user-agent) it was performed from. The History tab (/it/security/history)
 * renders those rows as the per-finding timeline: what happened, when, by whom
 * and from which IP.
 *
 * IP extraction matches the detection layer (src/middleware.ts) — first hop of
 * x-forwarded-for, else x-real-ip — so a resolution IP and an attack IP in
 * security_events are directly comparable.
 *
 * Recording is best-effort: a failure here must never fail the resolve/triage
 * request the user actually asked for, so errors are logged and swallowed.
 */
import { db } from "@/lib/db";
import { securityFindingActions } from "@/lib/db/schema";

export type FindingActionKind =
  | "acknowledged"
  | "resolved"
  | "false_positive"
  | "reopened"
  | "auto_apply";

/** How the action was carried out. Null where the distinction is meaningless. */
export type FindingActionMethod = "auto_apply" | "manual" | null;

export interface RequestOrigin {
  ip: string | null;
  userAgent: string | null;
}

/** First hop of x-forwarded-for, else x-real-ip. Null when neither is present (direct localhost). */
export function requestOrigin(req: Request): RequestOrigin {
  const forwarded = req.headers.get("x-forwarded-for");
  const first = forwarded ? forwarded.split(",")[0]?.trim() : "";
  const ip = first || req.headers.get("x-real-ip")?.trim() || null;
  const ua = req.headers.get("user-agent");
  return { ip: ip || null, userAgent: ua ? ua.slice(0, 512) : null };
}

export async function recordFindingAction(input: {
  findingId: string;
  action: FindingActionKind;
  method?: FindingActionMethod;
  actor: { id: string; email: string | null; role: string };
  origin: RequestOrigin;
  summary: string;
  detail?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await db.insert(securityFindingActions).values({
      finding_id: input.findingId,
      action: input.action,
      method: input.method ?? null,
      actor_user_id: input.actor.id,
      actor_email: input.actor.email,
      actor_role: input.actor.role,
      ip: input.origin.ip,
      user_agent: input.origin.userAgent,
      summary: input.summary,
      detail: input.detail ?? null,
    });
  } catch (e) {
    // Never let the audit write break the action itself.
    console.error("[security] failed to record finding action:", e instanceof Error ? e.message : e);
  }
}

/** Display helper shared by the API and the History UI. */
export const ACTION_LABELS: Record<FindingActionKind, string> = {
  acknowledged: "Acknowledged",
  resolved: "Marked resolved",
  false_positive: "Marked false positive",
  reopened: "Reopened",
  auto_apply: "Fix auto-applied to source",
};
