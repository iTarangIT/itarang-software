/**
 * E-387 — CIBIL review on an Acquire lead (parent / child approval hierarchy).
 *
 * GET  → the latest CIBIL submission + what the acting login may do on this
 *        lead (send, approve/reject, and the per-step lock state the lead page
 *        uses to grey out panels).
 * POST → multipart { file: PDF, note, score? } — a CHILD sends the report to
 *        the parent ('pending'); anyone else is the approver, so the report is
 *        recorded as approved straight away.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import {
  HIERARCHY_STEPS,
  decideCibilDecision,
  decideCibilSubmit,
  decideStep,
  getHierarchyContext,
  type GatedStep,
} from "@/lib/nbfc/approval-hierarchy";
import { CIBIL_MAX_BYTES, getCibilAwaitingView, getCibilReviewView, submitCibilReview } from "@/lib/nbfc/cibil-review";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  if (msg.startsWith("CONFLICT")) return 409;
  return 500;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);
    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json({ ok: false, error: "NOT_FOUND: no assignment for this lead under this tenant" }, { status: 404 });
    }
    const ctx = await getHierarchyContext(actor.tenant_id, actor.user_id, leadId);
    const isChild = !!ctx.parentUserId;
    const steps: Record<string, { ok: boolean; reason?: string }> = {};
    for (const s of [...HIERARCHY_STEPS.map((x) => x.key), "reject"] as GatedStep[]) {
      const d = decideStep(ctx, s);
      steps[s] = d.ok ? { ok: true } : { ok: false, reason: d.reason };
    }
    const submit = decideCibilSubmit(ctx);
    const decide = decideCibilDecision(ctx.review, { userId: actor.user_id, role: actor.role, isChild });
    return NextResponse.json({
      ok: true,
      review: await getCibilReviewView(actor.tenant_id, leadId),
      gate_applies: ctx.gateApplies,
      awaiting: isChild ? null : await getCibilAwaitingView(actor, leadId),
      me: {
        user_id: actor.user_id,
        is_child: isChild,
        parent_name: ctx.parentName ?? null,
        delegated_steps: ctx.delegatedSteps,
        can_submit: submit.ok && actor.role !== "viewer",
        can_decide: decide.ok,
      },
      steps,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}

const Fields = z.object({
  note: z.string().trim().min(1, "a note is required").max(2000),
  score: z
    .union([z.literal(""), z.coerce.number().int().min(300).max(900)])
    .optional()
    .transform((v) => (v === "" || v === undefined ? null : v)),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: expected multipart/form-data body" }, { status: 400 });
    }
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: attach the CIBIL report (PDF)" }, { status: 422 });
    }
    if (file.size > CIBIL_MAX_BYTES) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: the PDF is larger than 15 MB" }, { status: 413 });
    }
    const parsed = Fields.safeParse({ note: form.get("note") ?? "", score: form.get("score") ?? "" });
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: `BAD_REQUEST: ${parsed.error.issues[0]?.message ?? "invalid input"}` },
        { status: 400 },
      );
    }

    const result = await submitCibilReview({
      actor,
      leadId,
      file: { buf: Buffer.from(await file.arrayBuffer()), name: file.name },
      note: parsed.data.note,
      score: parsed.data.score,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
