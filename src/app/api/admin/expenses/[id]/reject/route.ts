/**
 * E-105 — POST /api/admin/expenses/[id]/reject
 * Body: { reason?: string }
 *
 * CEO-only gate. Flips an expense_submissions row to rejected with an
 * optional reason. Rejecting an already-approved row reverses approval —
 * the next CEO dashboard read recomputes "Other Business Expenses (MTD)"
 * from scratch, so the value naturally drops.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { expenseSubmissions } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RejectBody = z.object({ reason: z.string().max(1000).optional() });

function isCeo(user: { role?: string; email?: string }): boolean {
  const role = (user.role || "").toLowerCase();
  const email = (user.email || "").toLowerCase();
  return role === "ceo" || email === "sanchit@itarang.com";
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireAuth();
    if (!isCeo(user)) {
      return NextResponse.json(
        { success: false, error: { message: "FORBIDDEN: CEO approval required" } },
        { status: 403 },
      );
    }

    const { id } = await ctx.params;
    const json = await req.json().catch(() => ({}));
    const parsed = RejectBody.safeParse(json);
    const reason = parsed.success ? parsed.data.reason ?? null : null;

    const [row] = await db
      .select()
      .from(expenseSubmissions)
      .where(eq(expenseSubmissions.id, id))
      .limit(1);
    if (!row) {
      return NextResponse.json(
        { success: false, error: { message: "Not found" } },
        { status: 404 },
      );
    }

    await db
      .update(expenseSubmissions)
      .set({
        status: "rejected",
        approved_by: user.id,
        approved_at: null,
        rejection_reason: reason,
        updated_at: new Date(),
      })
      .where(eq(expenseSubmissions.id, id));

    return NextResponse.json({ success: true, id });
  } catch (e: any) {
    if (e?.digest?.startsWith?.("NEXT_REDIRECT")) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[expenses/reject] error:", msg);
    return NextResponse.json(
      { success: false, error: { message: msg } },
      { status: 500 },
    );
  }
}
