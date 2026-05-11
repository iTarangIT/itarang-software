/**
 * E-011 — NBFC status lifecycle state machine (BRD 6.0.6).
 *
 * 8-state graph; rejected and terminated are TERMINAL (no transitions out).
 * The transition map is the single source of truth — UI guards are advisory.
 *
 * States:
 *   draft, pending_admin_review, request_correction, approved, active,
 *   rejected, suspended, terminated
 */

export const NBFC_STATUSES = [
  "draft",
  "pending_admin_review",
  "request_correction",
  "approved",
  "active",
  "rejected",
  "suspended",
  "terminated",
] as const;

export type NbfcStatus = (typeof NBFC_STATUSES)[number];

/**
 * Allowed transitions: from -> set of allowed `to`.
 *
 * Mapping rationale (from BRD 6.0.6):
 *  - draft → pending_admin_review (admin submits) | rejected (admin abandons)
 *  - pending_admin_review → request_correction (reviewer flags issues)
 *                         | approved (gate passes — sibling E-001)
 *                         | rejected (admin rejects outright)
 *  - request_correction → pending_admin_review (re-submitted after edits)
 *                       | rejected
 *  - approved → active (first NBFC portal login — sibling E-002)
 *             | suspended (admin suspends before activation)
 *             | terminated (partnership ended)
 *  - active → suspended | terminated
 *  - suspended → active (un-suspended) | terminated
 *  - rejected → (terminal)
 *  - terminated → (terminal)
 *
 * NOTE: Some unit tests / sibling units use legacy "pending_review" as the
 * value already in the DB. Treat it as an alias of pending_admin_review so
 * existing E-001/E-005 fixtures keep working.
 */
const TRANSITIONS: Record<NbfcStatus, ReadonlySet<NbfcStatus>> = {
  draft: new Set(["pending_admin_review", "rejected"]),
  pending_admin_review: new Set([
    "request_correction",
    "approved",
    "rejected",
  ]),
  request_correction: new Set(["pending_admin_review", "rejected"]),
  approved: new Set(["active", "suspended", "terminated"]),
  active: new Set(["suspended", "terminated"]),
  rejected: new Set(),
  suspended: new Set(["active", "terminated"]),
  terminated: new Set(),
};

const LEGACY_ALIAS: Record<string, NbfcStatus> = {
  pending_review: "pending_admin_review",
};

export function normalizeStatus(s: string): NbfcStatus | null {
  if ((NBFC_STATUSES as readonly string[]).includes(s))
    return s as NbfcStatus;
  if (s in LEGACY_ALIAS) return LEGACY_ALIAS[s];
  return null;
}

export function isTerminal(s: NbfcStatus): boolean {
  return TRANSITIONS[s].size === 0;
}

export function isAllowedTransition(
  from: NbfcStatus,
  to: NbfcStatus,
): boolean {
  return TRANSITIONS[from].has(to);
}

export type TransitionGuardResult =
  | { ok: true; from: NbfcStatus; to: NbfcStatus }
  | { ok: false; code: "TERMINAL" | "NOT_ALLOWED" | "REASON_REQUIRED"; message: string };

/**
 * Pure validator: does NOT touch the DB. Use `applyTransition` for the full
 * write path.
 *
 * Special-case guards (per logic/4 in YAML):
 *  - to='rejected' requires non-empty reason
 *  - to='request_correction' SHOULD have reason (we make it optional but
 *    encourage it via a hint flag); not blocking per BRD wording.
 */
export function validateTransition(args: {
  from: string;
  to: string;
  reason?: string | null;
}): TransitionGuardResult {
  const fromN = normalizeStatus(args.from);
  if (!fromN) {
    return {
      ok: false,
      code: "NOT_ALLOWED",
      message: `Unknown current status '${args.from}'`,
    };
  }
  const toN = normalizeStatus(args.to);
  if (!toN) {
    return {
      ok: false,
      code: "NOT_ALLOWED",
      message: `Unknown target status '${args.to}'`,
    };
  }
  if (isTerminal(fromN)) {
    return {
      ok: false,
      code: "TERMINAL",
      message: `Status '${fromN}' is terminal — no further transitions allowed`,
    };
  }
  if (!isAllowedTransition(fromN, toN)) {
    return {
      ok: false,
      code: "NOT_ALLOWED",
      message: `Transition '${fromN}' → '${toN}' is not allowed`,
    };
  }
  if (toN === "rejected" && (!args.reason || args.reason.trim() === "")) {
    return {
      ok: false,
      code: "REASON_REQUIRED",
      message: "A non-empty reason is required when rejecting an NBFC",
    };
  }
  return { ok: true, from: fromN, to: toN };
}
