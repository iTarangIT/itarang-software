/**
 * GET /api/admin/nbfc/approvals/count
 *
 * Returns the number of NBFCs awaiting CEO review (status='pending_admin_review').
 * Drives the sidebar count badge for the CEO.
 *
 * Admin-gated. The earlier version of this route had no auth at all, on the
 * reasoning that "the sidebar only renders this link for the CEO anyway" — but
 * middleware.ts early-returns for every /api/** path (it only refreshes the
 * session cookie), so the `admin` segment in the URL gates nothing and the live
 * count was readable by a dealer session, or with no session at all. Only the
 * CEO branch of the sidebar calls this and it fails silently, so a 401/403 for
 * everyone else costs nothing.
 */
import { NextResponse } from "next/server";
import { count, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfc } from "@/lib/db/schema";
import { resolveAdminActor, statusFromError } from "@/lib/nbfc/admin/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await resolveAdminActor(request.headers);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "UNAUTHORIZED";
    return NextResponse.json(
      { error: msg.replace(/^[A-Z_]+:\s*/, "") },
      { status: statusFromError(msg) },
    );
  }

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
