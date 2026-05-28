/**
 * E-105 — POST /api/admin/expenses/[id]/approve
 *
 * CEO-only gate. Flips an expense_submissions row from pending → approved.
 * Approved expenses are included in "Other Business Expenses (MTD)" on the
 * CEO dashboard panel. Re-approving an already-approved row is a no-op.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { expenseSubmissions } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isCeo(user: { role?: string; email?: string }): boolean {
  const role = (user.role || "").toLowerCase();
  const email = (user.email || "").toLowerCase();
  return role === "ceo" || email === "sanchit@itarang.com";
}

export async function POST(
  _req: NextRequest,
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

    if (row.status === "approved") {
      return NextResponse.json({ success: true, id, idempotent: true });
    }

    await db
      .update(expenseSubmissions)
      .set({
        status: "approved",
        approved_by: user.id,
        approved_at: new Date(),
        rejection_reason: null,
        updated_at: new Date(),
      })
      .where(eq(expenseSubmissions.id, id));

    return NextResponse.json({ success: true, id });
  } catch (e: any) {
    if (e?.digest?.startsWith?.("NEXT_REDIRECT")) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[expenses/approve] error:", msg);
    return NextResponse.json(
      { success: false, error: { message: msg } },
      { status: 500 },
    );
  }
}
