/**
 * E-387 — NBFC parent / child CIBIL approval hierarchy: the pure rules.
 *
 * No I/O here (unit-tested in __tests__/approval-hierarchy-rules.test.ts); the
 * DB lookups live in ./approval-hierarchy.ts.
 *
 *  - A CHILD login (nbfc_users.parent_user_id set) uploads the CIBIL report +
 *    note and sends it to the parent. While it waits, the child is locked.
 *  - The PARENT (or any other nbfc_admin of the tenant, never the submitter)
 *    approves or rejects; a rejection needs a reason and closes the file for
 *    this NBFC.
 *  - After approval the parent owns the lead. The child may act only on the
 *    steps the NBFC admin ticked for him (delegated_steps).
 *  - "CIBIL approval required before any other step" is a tenant switch
 *    (nbfc_tenants.cibil_review_enabled_at). It applies to leads assigned on or
 *    after the moment it was switched on, so files already in flight are not
 *    frozen.
 */

/** Steps an NBFC admin can delegate to a child, in the order the UI shows them. */
export const HIERARCHY_STEPS = [
  { key: "kyc", label: "Verify KYC" },
  { key: "docs", label: "Ask for documents" },
  { key: "fi", label: "Field visit (FI)" },
  { key: "vkyc", label: "Video KYC" },
  { key: "offer", label: "Make offer" },
  { key: "sanction", label: "Sanction" },
  { key: "agreement", label: "Loan agreement" },
  { key: "enach", label: "E-NACH" },
] as const;

export type HierarchyStep = (typeof HIERARCHY_STEPS)[number]["key"];
/** Rejecting / removing the file is never delegable — parent side only. */
export type GatedStep = HierarchyStep | "reject";

export const HIERARCHY_STEP_KEYS: HierarchyStep[] = HIERARCHY_STEPS.map((s) => s.key);

export function isHierarchyStep(v: unknown): v is HierarchyStep {
  return typeof v === "string" && (HIERARCHY_STEP_KEYS as string[]).includes(v);
}

/** Keeps only known step keys, de-duplicated, in canonical order. */
export function cleanDelegatedSteps(v: unknown): HierarchyStep[] {
  const set = new Set(Array.isArray(v) ? v.filter(isHierarchyStep) : []);
  return HIERARCHY_STEP_KEYS.filter((k) => set.has(k));
}

export function stepLabel(step: GatedStep): string {
  if (step === "reject") return "Reject file";
  return HIERARCHY_STEPS.find((s) => s.key === step)?.label ?? step;
}

export type CibilReviewStatus = "pending" | "approved" | "rejected";

export interface HierarchyContext {
  /** Set ⇒ the acting login is a child of this user. */
  parentUserId: string | null;
  parentName?: string | null;
  delegatedSteps: HierarchyStep[];
  /** Tenant switch is on AND this lead was assigned after it was switched on. */
  gateApplies: boolean;
  /** Latest CIBIL submission on this lead for this tenant, if any. */
  review: { status: CibilReviewStatus; submittedBy: string; approverUserId: string } | null;
}

export type StepDecision = { ok: true } | { ok: false; reason: string };

/**
 * May the acting login perform `step` on this lead? Runs IN ADDITION to the
 * route's own role check — this can only take access away, never grant it.
 */
export function decideStep(ctx: HierarchyContext, step: GatedStep): StepDecision {
  const isChild = !!ctx.parentUserId;
  const status = ctx.review?.status ?? null;
  const parent = ctx.parentName || "your approver";

  if (isChild) {
    if (step === "reject") {
      return { ok: false, reason: `Only ${parent} can reject this file.` };
    }
    if (status === "pending") {
      return { ok: false, reason: `Waiting for ${parent} to approve the CIBIL report — your actions are locked until then.` };
    }
    if (status === "rejected") {
      return { ok: false, reason: "The CIBIL report was rejected — this file is closed." };
    }
    if (ctx.gateApplies && status !== "approved") {
      return { ok: false, reason: `Upload the CIBIL report and send it to ${parent} for approval first.` };
    }
    if (!ctx.delegatedSteps.includes(step)) {
      return {
        ok: false,
        reason: `${stepLabel(step)} is done by ${parent} on this lead. Your NBFC admin can give you this step in Settings → Users.`,
      };
    }
    return { ok: true };
  }

  // Parent / any non-child login.
  if (step === "reject") return { ok: true };
  // E-389 — the approver may ask for more documents BEFORE deciding the CIBIL
  // report (Battery Pool diagram 3); every other step waits for approval.
  if (step === "docs" && status === "pending") return { ok: true };
  if (ctx.gateApplies && status !== "approved") {
    return {
      ok: false,
      reason:
        status === "pending"
          ? "The CIBIL report is waiting for approval — approve it first."
          : status === "rejected"
            ? "The CIBIL report was rejected — this file is closed."
            : "CIBIL approval is required before any other step — upload the CIBIL report first.",
    };
  }
  return { ok: true };
}

/** Whether the acting login may send a (new) CIBIL report on this lead. */
export function decideCibilSubmit(ctx: HierarchyContext): StepDecision {
  const status = ctx.review?.status ?? null;
  if (status === "pending") return { ok: false, reason: "A CIBIL report is already waiting for approval." };
  if (status === "approved") return { ok: false, reason: "The CIBIL report is already approved." };
  if (status === "rejected") return { ok: false, reason: "The CIBIL report was rejected — this file is closed." };
  return { ok: true };
}

/**
 * Whether `actor` may approve / reject a PENDING review: the named approver,
 * or any other nbfc_admin of the tenant (cover when the parent is away) —
 * never the person who submitted it.
 */
export function decideCibilDecision(
  review: { status: CibilReviewStatus; submittedBy: string; approverUserId: string } | null,
  actor: { userId: string; role: string; isChild: boolean },
): StepDecision {
  if (!review || review.status !== "pending") return { ok: false, reason: "There is no CIBIL report waiting for approval." };
  if (review.submittedBy === actor.userId) return { ok: false, reason: "You cannot approve your own CIBIL report." };
  if (review.approverUserId === actor.userId) return { ok: true };
  if (actor.role === "nbfc_admin" && !actor.isChild) return { ok: true };
  return { ok: false, reason: "Only the approver or an NBFC admin can decide this CIBIL report." };
}

/**
 * E-389 — whether `actor` may ask for additional documents on a PENDING CIBIL
 * report (the review stays pending until the documents come back). Same people
 * as decideCibilDecision: the approver or another non-child nbfc_admin, never
 * the submitter.
 */
export function decideCibilDocRequest(
  review: { status: CibilReviewStatus; submittedBy: string; approverUserId: string } | null,
  actor: { userId: string; role: string; isChild: boolean },
): StepDecision {
  const d = decideCibilDecision(review, actor);
  if (d.ok) return d;
  if (!review || review.status !== "pending") {
    return { ok: false, reason: "Documents can only be requested while the CIBIL report is waiting for approval." };
  }
  if (review.submittedBy === actor.userId) {
    return { ok: false, reason: "The approver asks for documents — you sent this CIBIL report." };
  }
  return { ok: false, reason: "Only the approver or an NBFC admin can ask for documents on this CIBIL report." };
}
