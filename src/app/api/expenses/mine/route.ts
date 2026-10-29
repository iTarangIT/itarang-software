/**
 * E-105 — GET /api/expenses/mine
 *
 * Returns the current user's expense submission history (latest 100).
 * Used by the user-facing submission page to show status + audit trail.
 *
 * ID 197: each Travel / Vehicle-Fuel claim also carries its travel proof
 * summary ("2 of 3 days supported"), so the submitter can open their own Day
 * evidence (GET /api/expenses/[id]/travel-proof lets the submitter in).
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { expenseSubmissions } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { requireAuth } from "@/lib/auth-utils";
import { claimDaysFor } from "@/lib/expenses/travelProofStore";
import { proofSummary } from "@/lib/expenses/travelProof";

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
    const days = await claimDaysFor(rows.map((r) => r.id)).catch(() => new Map());
    const data = rows.map((r) => {
      const d = days.get(r.id) ?? [];
      return { ...r, travel_proof: d.length ? { summary: proofSummary(d) } : null };
    });
    return NextResponse.json({ success: true, data });
  } catch (e: any) {
    if (e?.digest?.startsWith?.("NEXT_REDIRECT")) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { success: false, error: { message: msg } },
      { status: 500 },
    );
  }
}
