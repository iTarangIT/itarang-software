/**
 * GET/POST /api/admin/leads/[id]/resume — 23 Nov 2026 (Battery Pool, tasks 8 + 9).
 *
 * Resume a file an NBFC rejected, after the customer sent corrected documents.
 * Admin / sales head (and CEO / business head) only.
 *
 *   GET  → the rejection(s), resume history, whether it can be resumed, and
 *          the other lenders/schemes that fit the lead now.
 *   POST { mode: "same_nbfc", note, assignment_id? }
 *        { mode: "other_nbfc", note, nbfc_id, loan_product_id }
 *        { mode: "new_dealer", note, dealer_id }   → a NEW lead (new case)
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { nbfcLeadAssignments } from "@/lib/db/schema";
import { requireAdminAppUserForLead } from "@/lib/kyc/admin-workflow";
import { listSchemeOptions, mayPickScheme } from "@/lib/leads/scheme-pick";
import { ResumeError, getResumeView, resumeRejectedLead } from "@/lib/leads/resume-rejected";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: leadId } = await params;
  const user = await requireAdminAppUserForLead(leadId);
  if (!user) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  try {
    const view = await getResumeView(leadId);
    if (!view) return NextResponse.json({ ok: false, error: "Lead not found" }, { status: 404 });
    let otherOptions: Awaited<ReturnType<typeof listSchemeOptions>> = [];
    if (view.can_resume) {
      const used = new Set(
        (
          await db
            .select({ nbfc_id: nbfcLeadAssignments.nbfc_id })
            .from(nbfcLeadAssignments)
            .where(eq(nbfcLeadAssignments.lead_id, leadId))
        ).map((a) => a.nbfc_id),
      );
      otherOptions = (await listSchemeOptions(leadId).catch(() => [])).filter((o) => !used.has(o.nbfcId));
    }
    return NextResponse.json({
      ok: true,
      ...view,
      other_nbfc_options: otherOptions,
      can_act: mayPickScheme(user.role),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

const Body = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("same_nbfc"), note: z.string().min(1).max(1000), assignment_id: z.string().uuid().optional() }),
  z.object({
    mode: z.literal("other_nbfc"),
    note: z.string().min(1).max(1000),
    nbfc_id: z.coerce.number().int().positive(),
    loan_product_id: z.coerce.number().int().positive(),
  }),
  z.object({ mode: z.literal("new_dealer"), note: z.string().min(1).max(1000), dealer_id: z.string().min(1).max(255) }),
]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: leadId } = await params;
  const user = await requireAdminAppUserForLead(leadId);
  if (!user || !mayPickScheme(user.role)) {
    return NextResponse.json({ ok: false, error: "Only an admin or sales head can resume a rejected file" }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Write what the customer corrected and pick how to resume" },
      { status: 400 },
    );
  }
  const d = parsed.data;
  try {
    const r = await resumeRejectedLead({
      leadId,
      mode: d.mode,
      note: d.note,
      actor: { id: user.id, name: user.name ?? user.email ?? null, role: user.role },
      assignmentId: d.mode === "same_nbfc" ? d.assignment_id ?? null : null,
      nbfcId: d.mode === "other_nbfc" ? d.nbfc_id : null,
      loanProductId: d.mode === "other_nbfc" ? d.loan_product_id : null,
      newDealerId: d.mode === "new_dealer" ? d.dealer_id : null,
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof ResumeError) return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    console.error("[resume] failed", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
