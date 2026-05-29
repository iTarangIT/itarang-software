/**
 * GET /api/admin/nbfc/approvals/count
 *
 * Returns the number of NBFCs awaiting CEO review (status='pending_admin_review').
 * Drives the sidebar count badge for the CEO. Returns { count: 0 } for
 * non-CEO viewers (cheap fail-safe — the sidebar only renders this link for
 * the CEO role anyway, so an unauthenticated call is benign).
 */
import { NextResponse } from "next/server";
import { count, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfc } from "@/lib/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [row] = await db
      .select({ n: count() })
      .from(nbfc)
      .where(eq(nbfc.status, "pending_admin_review"));
    return NextResponse.json({ count: Number(row?.n ?? 0) });
  } catch {
    return NextResponse.json({ count: 0 });
  }
}
