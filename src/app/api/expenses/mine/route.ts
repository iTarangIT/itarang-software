/**
 * E-105 — GET /api/expenses/mine
 *
 * Returns the current user's expense submission history (latest 100).
 * Used by the user-facing submission page to show status + audit trail.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { expenseSubmissions } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { requireAuth } from "@/lib/auth-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireAuth();
    const rows = await db
      .select()
      .from(expenseSubmissions)
      .where(eq(expenseSubmissions.submitted_by, user.id))
      .orderBy(desc(expenseSubmissions.created_at))
      .limit(100);
    return NextResponse.json({ success: true, data: rows });
  } catch (e: any) {
    if (e?.digest?.startsWith?.("NEXT_REDIRECT")) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { success: false, error: { message: msg } },
      { status: 500 },
    );
  }
}
