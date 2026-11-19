/**
 * E-387 — NBFC parent / child CIBIL approval hierarchy: DB side.
 * Rules live in ./approval-hierarchy-rules.ts (pure, unit-tested).
 *
 * Every Acquire action route calls `assertHierarchyStep(actor, leadId, step)`
 * right after resolving the actor. It throws a `FORBIDDEN: …` error (→ 403 via
 * the routes' statusFromError) when the hierarchy says no.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfcCibilReviews, nbfcLeadAssignments, nbfcTenants, nbfcUsers, users } from "@/lib/db/schema";
import {
  cleanDelegatedSteps,
  decideStep,
  type CibilReviewStatus,
  type GatedStep,
  type HierarchyContext,
} from "./approval-hierarchy-rules";

import {
  CHILD_DEFAULT_NAV,
  CHILD_DEFAULT_TITLE,
  DEFAULT_TITLE,
  cleanAllowedNav,
  type NbfcNavId,
} from "./portal-nav";

export * from "./approval-hierarchy-rules";

/**
 * E-388 — what the logged-in user sees in the NBFC portal: which sidebar menus
 * (null ⇒ all) and the designation for the header / profile. A child with no
 * explicit menu list gets Acquire only; a child with no title is a
 * "Credit Verifier".
 */
export async function getPortalAccess(
  tenantId: string,
  userId: string,
): Promise<{ allowedNav: NbfcNavId[] | null; title: string; isChild: boolean }> {
  const [m] = await db
    .select({ parent: nbfcUsers.parent_user_id, nav: nbfcUsers.allowed_nav, title: nbfcUsers.title })
    .from(nbfcUsers)
    .where(and(eq(nbfcUsers.user_id, userId), eq(nbfcUsers.tenant_id, tenantId)))
    .limit(1);
  const isChild = !!m?.parent;
  const explicit = cleanAllowedNav(m?.nav ?? null);
  return {
    allowedNav: explicit ?? (isChild ? [...CHILD_DEFAULT_NAV] : null),
    title: m?.title?.trim() || (isChild ? CHILD_DEFAULT_TITLE : DEFAULT_TITLE),
    isChild,
  };
}

export interface CibilReviewRow {
  id: string;
  status: CibilReviewStatus;
  submitted_by: string;
  approver_user_id: string;
  report_url: string;
  report_file_name: string | null;
  cibil_score: number | null;
  note: string;
  decision_reason: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
}

export async function getLatestCibilReview(tenantId: string, leadId: string): Promise<CibilReviewRow | null> {
  const [row] = await db
    .select({
      id: nbfcCibilReviews.id,
      status: nbfcCibilReviews.status,
      submitted_by: nbfcCibilReviews.submitted_by,
      approver_user_id: nbfcCibilReviews.approver_user_id,
      report_url: nbfcCibilReviews.report_url,
      report_file_name: nbfcCibilReviews.report_file_name,
      cibil_score: nbfcCibilReviews.cibil_score,
      note: nbfcCibilReviews.note,
      decision_reason: nbfcCibilReviews.decision_reason,
      decided_by: nbfcCibilReviews.decided_by,
      decided_at: nbfcCibilReviews.decided_at,
      created_at: nbfcCibilReviews.created_at,
    })
    .from(nbfcCibilReviews)
    .where(and(eq(nbfcCibilReviews.tenant_id, tenantId), eq(nbfcCibilReviews.lead_id, leadId)))
    .orderBy(desc(nbfcCibilReviews.created_at))
    .limit(1);
  return row ? { ...row, status: row.status as CibilReviewStatus } : null;
}

/** The acting login's place in the hierarchy (parent + delegated steps). */
export async function getMembership(tenantId: string, userId: string) {
  const [m] = await db
    .select({ parent_user_id: nbfcUsers.parent_user_id, delegated_steps: nbfcUsers.delegated_steps })
    .from(nbfcUsers)
    .where(and(eq(nbfcUsers.user_id, userId), eq(nbfcUsers.tenant_id, tenantId)))
    .limit(1);
  let parentName: string | null = null;
  if (m?.parent_user_id) {
    const [p] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, m.parent_user_id))
      .limit(1);
    parentName = p?.name || p?.email || null;
  }
  return {
    parentUserId: m?.parent_user_id ?? null,
    parentName,
    delegatedSteps: cleanDelegatedSteps(m?.delegated_steps),
  };
}

/** Is "CIBIL approval required before any other step" in force for this lead? */
export async function cibilGateApplies(tenantId: string, leadId: string): Promise<boolean> {
  const [t] = await db
    .select({ enabledAt: nbfcTenants.cibil_review_enabled_at })
    .from(nbfcTenants)
    .where(eq(nbfcTenants.id, tenantId))
    .limit(1);
  if (!t?.enabledAt) return false;
  const [a] = await db
    .select({ assignedAt: nbfcLeadAssignments.assigned_at })
    .from(nbfcLeadAssignments)
    .where(and(eq(nbfcLeadAssignments.lead_id, leadId), eq(nbfcLeadAssignments.tenant_id, tenantId)))
    .limit(1);
  return !!a && a.assignedAt.getTime() >= t.enabledAt.getTime();
}

export async function getHierarchyContext(
  tenantId: string,
  userId: string,
  leadId: string,
): Promise<HierarchyContext & { reviewRow: CibilReviewRow | null }> {
  const [membership, gateApplies, review] = await Promise.all([
    getMembership(tenantId, userId),
    cibilGateApplies(tenantId, leadId),
    getLatestCibilReview(tenantId, leadId),
  ]);
  return {
    ...membership,
    gateApplies,
    review: review
      ? { status: review.status, submittedBy: review.submitted_by, approverUserId: review.approver_user_id }
      : null,
    reviewRow: review,
  };
}

/** Throws `FORBIDDEN: <reason>` when the hierarchy blocks this step. */
export async function assertHierarchyStep(
  actor: { tenant_id: string; user_id: string },
  leadId: string,
  step: GatedStep,
): Promise<void> {
  const ctx = await getHierarchyContext(actor.tenant_id, actor.user_id, leadId);
  const d = decideStep(ctx, step);
  if (!d.ok) throw new Error(`FORBIDDEN: ${d.reason}`);
}

/**
 * Validates "child reports to parent" inside one tenant. One level only: the
 * parent must be a member and must not itself be a child, and a login that
 * already has children cannot become a child. Throws BAD_REQUEST / CONFLICT.
 */
export async function assertValidParent(tenantId: string, childUserId: string | null, parentUserId: string) {
  if (childUserId && childUserId === parentUserId) throw new Error("BAD_REQUEST: a user cannot report to themselves");
  const [parent] = await db
    .select({ parent_user_id: nbfcUsers.parent_user_id })
    .from(nbfcUsers)
    .where(and(eq(nbfcUsers.user_id, parentUserId), eq(nbfcUsers.tenant_id, tenantId)))
    .limit(1);
  if (!parent) throw new Error("BAD_REQUEST: the approver must be a user of this NBFC");
  if (parent.parent_user_id) throw new Error("BAD_REQUEST: the approver is a child user — pick a parent who reports to nobody");
  if (childUserId) {
    const [hasChild] = await db
      .select({ user_id: nbfcUsers.user_id })
      .from(nbfcUsers)
      .where(and(eq(nbfcUsers.tenant_id, tenantId), eq(nbfcUsers.parent_user_id, childUserId)))
      .limit(1);
    if (hasChild) throw new Error("CONFLICT: this user is an approver for others — move those users first");
  }
}
