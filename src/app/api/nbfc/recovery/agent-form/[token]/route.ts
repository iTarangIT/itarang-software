/**
 * E-262 — GET /api/nbfc/recovery/agent-form/[token] — PUBLIC, token-gated.
 *
 * The job card the agent opens on their phone. NO auth: the token IS the
 * credential. Returns the minimum needed to do the job — who, where, which
 * battery, and how to ring ahead — so a misdirected link discloses no arrears,
 * no outstanding and no DPD.
 *
 * WHY THIS DOES NOT 410 FOR EVERY DEAD TOKEN. The FI equivalent collapses
 * invalid, expired, submitted and cancelled into one message: "this link is
 * invalid, expired, or already used". For a recovery agent that is actively
 * dangerous — somebody told their link is broken phones the office or knocks
 * anyway, while somebody told "this was cancelled, the borrower paid" goes
 * home. So the state comes back named, and the page renders a different screen
 * for each.
 */
import { NextRequest, NextResponse } from "next/server";

import {
  loadLoanContext,
  resolveAssignmentByToken,
  listVisitAttempts,
} from "@/lib/nbfc/recovery/assignment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const res = await resolveAssignmentByToken(token);

  if (res.state === "unknown") {
    return NextResponse.json(
      {
        ok: false,
        state: "unknown",
        message:
          "This link is not valid. Check you opened the most recent message, or contact the office.",
      },
      { status: 410 },
    );
  }

  if (res.state === "cancelled") {
    return NextResponse.json(
      {
        ok: false,
        state: "cancelled",
        message:
          res.assignment.cancel_source === "emi_payment"
            ? "The borrower has paid. Do NOT collect this battery."
            : "This collection has been cancelled. Do NOT collect this battery.",
        reason: res.assignment.cancel_reason,
      },
      { status: 410 },
    );
  }

  if (res.state === "completed") {
    return NextResponse.json(
      {
        ok: false,
        state: "completed",
        message: "This collection has already been submitted. Nothing further to do.",
      },
      { status: 410 },
    );
  }

  if (res.state === "expired") {
    return NextResponse.json(
      {
        ok: false,
        state: "expired",
        message:
          "This link has expired. Ask the office to send you a new one — your job is still open.",
      },
      { status: 410 },
    );
  }

  const a = res.assignment;
  const ctx = await loadLoanContext(a.tenant_id, a.loan_sanction_id);
  const visits = await listVisitAttempts(a.id);

  return NextResponse.json({
    ok: true,
    state: "ok",
    assignment_id: a.id,
    borrower_name: ctx?.borrower_name ?? "the borrower",
    borrower_phone: ctx?.borrower_phone ?? null,
    address: ctx?.address ?? null,
    city: ctx?.city ?? null,
    state_name: ctx?.state ?? null,
    dealer_name: ctx?.dealer_name ?? null,
    nbfc_name: ctx?.nbfc_name ?? null,
    // Null when the flag was raised without one. The form then ASKS for it —
    // the agent is the person holding the battery, so they are the right one
    // to read it off the casing.
    battery_serial: a.battery_serial,
    expires_at: a.link_expires_at,
    due_at: a.due_at,
    // So a returning agent sees what they already reported rather than
    // wondering whether their last submission went through.
    previous_visits: visits.map((v) => ({
      attempt_no: v.attempt_no,
      outcome: v.outcome,
      notes: v.notes,
      next_visit_at: v.next_visit_at,
      created_at: v.created_at,
    })),
  });
}
