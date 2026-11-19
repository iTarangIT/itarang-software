/**
 * E-387 — CIBIL review: submit (child → parent), approve, reject.
 *
 *  submit  — child uploads the CIBIL PDF + note → row 'pending' for his parent.
 *            A non-child (the parent / any NBFC admin doing it himself) is
 *            recorded as approved straight away — he is the approver.
 *  approve — parent (or another nbfc_admin, never the submitter) → 'approved'.
 *            From here the parent owns the lead; the child keeps only the
 *            steps delegated to him.
 *  reject  — reason mandatory → 'rejected' AND the NBFC's assignment is
 *            declined exactly like "Reject file" (rejectNbfcFile).
 *
 * Throws prefix-tagged errors for the routes' statusFromError.
 */
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, nbfcAuditLog, nbfcCibilReviews, nbfcUsers, users } from "@/lib/db/schema";
import { sendEmail } from "@/lib/email/mailer";
import { esc } from "@/lib/nbfc/event-mailer";
import { putNbfcObject } from "@/lib/nbfc/nbfc-storage";
import { isAssignmentDecided } from "@/lib/nbfc/offer-negotiation";
import { RECALLED_ERROR, isLeadRecalled } from "@/lib/nbfc/recall";
import { rejectNbfcFile } from "@/lib/nbfc/reject-file";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { tenantDisplayName } from "@/lib/notifications/emit";
import {
  decideCibilDecision,
  decideCibilSubmit,
  getHierarchyContext,
  getLatestCibilReview,
} from "./approval-hierarchy";

export const CIBIL_MAX_BYTES = 15 * 1024 * 1024;

export function isPdf(buf: Buffer): boolean {
  return buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d;
}

type Actor = { tenant_id: string; user_id: string; role: string };

async function loadOpenAssignment(tenantId: string, leadId: string) {
  const assignment = await getActiveAssignment(leadId, tenantId);
  if (!assignment) throw new Error("BAD_REQUEST: no assignment for this lead under this tenant");
  if (isAssignmentDecided(assignment.status)) {
    throw new Error(`BAD_REQUEST: this file is already decided (status '${assignment.status}')`);
  }
  const [lead] = await db
    .select({
      recalled_at: leads.recalled_at,
      resubmitted_at: leads.resubmitted_at,
      full_name: leads.full_name,
      owner_name: leads.owner_name,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (isLeadRecalled(lead)) throw new Error(RECALLED_ERROR);
  return { assignment, customerName: lead?.full_name ?? lead?.owner_name ?? null };
}

async function userLabels(ids: string[]): Promise<Map<string, { name: string; email: string | null }>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, uniq));
  return new Map(rows.map((r) => [r.id, { name: r.name || r.email || "—", email: r.email ?? null }]));
}

/** One-person notification (approver / submitter). Never throws. */
async function mailUser(opts: {
  userId: string;
  subject: string;
  heading: string;
  rows: Array<[string, string | null | undefined]>;
  leadId: string;
}) {
  try {
    const who = (await userLabels([opts.userId])).get(opts.userId);
    if (!who?.email) return;
    const origin = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "";
    const link = origin ? `${origin.replace(/\/$/, "")}/nbfc/acquire/${encodeURIComponent(opts.leadId)}` : "";
    const rows = opts.rows
      .filter(([, v]) => v != null && String(v).trim() !== "")
      .map(
        ([k, v]) =>
          `<tr><td style="padding:4px 12px 4px 0;color:#64748b;vertical-align:top">${esc(k)}</td><td>${esc(v)}</td></tr>`,
      )
      .join("");
    await sendEmail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: who.email,
      subject: opts.subject,
      html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1e293b">
        <p style="font-size:15px"><b>${esc(opts.heading)}</b></p>
        <table style="border-collapse:collapse">${rows}</table>
        ${link ? `<p><a href="${esc(link)}">Open the lead in the NBFC portal</a></p>` : ""}
        <p style="color:#94a3b8;font-size:12px">This is an automated iTarang CRM notification for Lead ${esc(opts.leadId)}.</p>
      </div>`,
    });
  } catch (err) {
    console.warn("[cibil-review] notification email failed", err instanceof Error ? err.message : String(err));
  }
}

export async function submitCibilReview(opts: {
  actor: Actor;
  leadId: string;
  file: { buf: Buffer; name: string };
  note: string;
  score: number | null;
}) {
  const { actor, leadId, note, score } = opts;
  if (actor.role === "viewer") throw new Error("FORBIDDEN: a viewer cannot upload the CIBIL report");
  if (!isPdf(opts.file.buf)) throw new Error("BAD_REQUEST: only PDF files are accepted");

  const { assignment, customerName } = await loadOpenAssignment(actor.tenant_id, leadId);
  const ctx = await getHierarchyContext(actor.tenant_id, actor.user_id, leadId);
  const can = decideCibilSubmit(ctx);
  if (!can.ok) throw new Error(`CONFLICT: ${can.reason}`);

  const isChild = !!ctx.parentUserId;
  if (isChild) {
    // The parent must still be a member of this tenant.
    const [p] = await db
      .select({ user_id: nbfcUsers.user_id })
      .from(nbfcUsers)
      .where(and(eq(nbfcUsers.user_id, ctx.parentUserId!), eq(nbfcUsers.tenant_id, actor.tenant_id)))
      .limit(1);
    if (!p) throw new Error("BAD_REQUEST: your approver is no longer on this NBFC — ask your NBFC admin to set a new one");
  }

  const now = new Date();
  const safeName = (opts.file.name || "cibil-report.pdf").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  const { url } = await putNbfcObject(`cibil-reviews/${leadId}/${now.getTime()}.pdf`, opts.file.buf, "application/pdf");

  const status = isChild ? "pending" : "approved";
  const approver = isChild ? ctx.parentUserId! : actor.user_id;

  let reviewId: string;
  try {
    reviewId = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(nbfcCibilReviews)
        .values({
          tenant_id: actor.tenant_id,
          lead_id: leadId,
          assignment_id: assignment.id,
          submitted_by: actor.user_id,
          approver_user_id: approver,
          report_url: url,
          report_file_name: safeName,
          cibil_score: score,
          note,
          status,
          decided_by: isChild ? null : actor.user_id,
          decided_at: isChild ? null : now,
          decision_reason: isChild ? null : "Uploaded by the approver",
          created_at: now,
          updated_at: now,
        })
        .returning({ id: nbfcCibilReviews.id });
      await tx.insert(nbfcAuditLog).values({
        tenant_id: actor.tenant_id,
        user_id: actor.user_id,
        action_type: isChild ? "cibil_review_submitted" : "cibil_review_approved",
        action_id: row.id,
        before_state: null,
        after_state: { lead_id: leadId, status, approver_user_id: approver, cibil_score: score, note },
        created_at: now,
      });
      return row.id;
    });
  } catch (err) {
    // nbfc_cibil_reviews_one_pending_uniq — a parallel submit won the race.
    const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code ?? (err as { code?: string })?.code;
    if (code === "23505") throw new Error("CONFLICT: A CIBIL report is already waiting for approval.");
    throw err;
  }

  if (isChild) {
    const submitter = (await userLabels([actor.user_id])).get(actor.user_id);
    void mailUser({
      userId: approver,
      leadId,
      subject: `CIBIL report waiting for your approval — Lead ${leadId}`,
      heading: `${submitter?.name ?? "Your team member"} sent a CIBIL report for your approval.`,
      rows: [
        ["Lead ID", leadId],
        ["Customer", customerName],
        ["NBFC", await tenantDisplayName(actor.tenant_id)],
        ["CIBIL score", score != null ? String(score) : null],
        ["Note", note],
      ],
    });
  }

  return { id: reviewId, status };
}

export async function decideCibilReview(opts: {
  actor: Actor;
  leadId: string;
  decision: "approve" | "reject";
  reason: string | null;
}) {
  const { actor, leadId, decision } = opts;
  const reason = opts.reason?.trim() || null;
  if (decision === "reject" && !reason) throw new Error("BAD_REQUEST: a reason is required to reject");

  const ctx = await getHierarchyContext(actor.tenant_id, actor.user_id, leadId);
  const review = ctx.reviewRow;
  const can = decideCibilDecision(ctx.review, {
    userId: actor.user_id,
    role: actor.role,
    isChild: !!ctx.parentUserId,
  });
  if (!can.ok) throw new Error(`FORBIDDEN: ${can.reason}`);

  const { customerName } = await loadOpenAssignment(actor.tenant_id, leadId);
  const now = new Date();
  const status = decision === "approve" ? "approved" : "rejected";

  // Guarded on status='pending' so two approvers clicking at once can't both win.
  const updated = await db
    .update(nbfcCibilReviews)
    .set({ status, decision_reason: reason, decided_by: actor.user_id, decided_at: now, updated_at: now })
    .where(and(eq(nbfcCibilReviews.id, review!.id), eq(nbfcCibilReviews.status, "pending")))
    .returning({ id: nbfcCibilReviews.id });
  if (!updated.length) throw new Error("CONFLICT: this CIBIL report was already decided — refresh the page");

  await db.insert(nbfcAuditLog).values({
    tenant_id: actor.tenant_id,
    user_id: actor.user_id,
    action_type: decision === "approve" ? "cibil_review_approved" : "cibil_review_rejected",
    action_id: review!.id,
    before_state: { lead_id: leadId, status: "pending" },
    after_state: { lead_id: leadId, status, reason },
    created_at: now,
  });

  if (decision === "reject") {
    // Close the file for this NBFC — same path as "Reject file".
    await rejectNbfcFile({
      actor,
      leadId,
      note: `CIBIL report rejected: ${reason}`,
      auditExtra: { via: "cibil_review", cibil_review_id: review!.id },
    });
  }

  const decider = (await userLabels([actor.user_id])).get(actor.user_id);
  void mailUser({
    userId: review!.submitted_by,
    leadId,
    subject: `CIBIL report ${status} — Lead ${leadId}`,
    heading:
      decision === "approve"
        ? `${decider?.name ?? "Your approver"} approved the CIBIL report. The lead now continues with them.`
        : `${decider?.name ?? "Your approver"} rejected the CIBIL report. The file is closed.`,
    rows: [
      ["Lead ID", leadId],
      ["Customer", customerName],
      ["Reason", reason],
    ],
  });

  return { id: review!.id, status };
}

/** Review + people names for the lead page panel. */
export async function getCibilReviewView(tenantId: string, leadId: string) {
  const review = await getLatestCibilReview(tenantId, leadId);
  if (!review) return null;
  const names = await userLabels([review.submitted_by, review.approver_user_id, review.decided_by ?? ""]);
  return {
    id: review.id,
    status: review.status,
    note: review.note,
    cibil_score: review.cibil_score,
    report_file_name: review.report_file_name,
    decision_reason: review.decision_reason,
    created_at: review.created_at.toISOString(),
    decided_at: review.decided_at?.toISOString() ?? null,
    submitted_by: { id: review.submitted_by, name: names.get(review.submitted_by)?.name ?? "—" },
    approver: { id: review.approver_user_id, name: names.get(review.approver_user_id)?.name ?? "—" },
    decided_by: review.decided_by
      ? { id: review.decided_by, name: names.get(review.decided_by)?.name ?? "—" }
      : null,
  };
}
