/**
 * E-105 — GET /api/admin/expenses?status=pending|approved|rejected
 *
 * CEO-only. Lists expense submissions filtered by status (default pending),
 * joined with users to surface submitter name + role on the approvals page.
 */
import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { expenseSubmissions, users } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set(["pending", "approved", "rejected"]);

function isCeo(user: { role?: string; email?: string }): boolean {
  const role = (user.role || "").toLowerCase();
  const email = (user.email || "").toLowerCase();
  return role === "ceo" || email === "sanchit@itarang.com";
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireAuth();
    if (!isCeo(user)) {
      return NextResponse.json(
        { success: false, error: { message: "FORBIDDEN: CEO only" } },
        { status: 403 },
      );
    }
    const status = (new URL(req.url).searchParams.get("status") || "pending").toLowerCase();
    if (!ALLOWED.has(status)) {
      return NextResponse.json(
        { success: false, error: { message: "Invalid status filter" } },
        { status: 400 },
      );
    }

    const rows = await db
      .select({
        id: expenseSubmissions.id,
        category: expenseSubmissions.category,
        amount: expenseSubmissions.amount,
        description: expenseSubmissions.description,
        bill_url: expenseSubmissions.bill_url,
        status: expenseSubmissions.status,
        rejection_reason: expenseSubmissions.rejection_reason,
        created_at: expenseSubmissions.created_at,
        approved_at: expenseSubmissions.approved_at,
        submitter_id: users.id,
        submitter_name: users.name,
        submitter_email: users.email,
        submitter_role: users.role,
      })
      .from(expenseSubmissions)
      .leftJoin(users, eq(expenseSubmissions.submitted_by, users.id))
      .where(eq(expenseSubmissions.status, status))
      .orderBy(desc(expenseSubmissions.created_at))
      .limit(200);

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
