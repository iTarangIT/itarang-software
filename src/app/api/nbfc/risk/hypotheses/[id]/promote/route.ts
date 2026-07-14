/**
 * POST /api/nbfc/risk/hypotheses/[id]/promote  — vet an agent-authored hypothesis
 * DELETE (same path)                            — retire one
 *
 * E-188. Until a human promotes it, an `llm-v1` hypothesis is capped at `warn`
 * when its card is written: it may raise a concern, it may not declare a crisis.
 * Promotion is the human-in-the-loop step that lets it into the High Alert queue.
 *
 * Promotion is a claim about the QUESTION and the CODE, not about today's
 * numbers — so it lives on the hypothesis, not on the card, and it persists
 * across runs.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { riskHypotheses } from "@/lib/db/schema";
import { clientError } from "@/lib/nbfc/http-error";
import { getCurrentTenant, getSessionUser, requireNbfcAccess } from "@/lib/nbfc/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const tenant = await getCurrentTenant();
    await requireNbfcAccess(tenant.id);
    const user = await getSessionUser();

    const [row] = await db.select().from(riskHypotheses).where(eq(riskHypotheses.id, id)).limit(1);
    if (!row) {
      return NextResponse.json({ ok: false, error: "Hypothesis not found." }, { status: 404 });
    }
    if (row.promoted_at) {
      return NextResponse.json({ ok: true, already_promoted: true, promoted_at: row.promoted_at });
    }

    await db
      .update(riskHypotheses)
      .set({ promoted_at: new Date(), promoted_by: user?.id ?? null })
      .where(eq(riskHypotheses.id, id));

    // Existing cards keep the severity they were written with. The promotion
    // takes effect on the next run, when the cap no longer applies — we do not
    // retroactively rewrite a verdict a human never saw.
    return NextResponse.json({ ok: true, promoted: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("UNAUTHORIZED") ? 401 : msg.startsWith("FORBIDDEN") ? 403 : 500;
    return NextResponse.json({ ok: false, error: clientError(e) }, { status });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const tenant = await getCurrentTenant();
    await requireNbfcAccess(tenant.id);

    // Soft retire: the row and its card history stay, it is simply no longer
    // executed or rendered.
    await db
      .update(riskHypotheses)
      .set({ retired_at: new Date(), retire_reason: "Retired by an operator." })
      .where(eq(riskHypotheses.id, id));

    return NextResponse.json({ ok: true, retired: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("UNAUTHORIZED") ? 401 : msg.startsWith("FORBIDDEN") ? 403 : 500;
    return NextResponse.json({ ok: false, error: clientError(e) }, { status });
  }
}
