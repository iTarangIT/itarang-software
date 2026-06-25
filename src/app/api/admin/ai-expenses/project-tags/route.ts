/**
 * E-106 — GET /api/admin/ai-expenses/project-tags?department=tech
 *
 * Admin-only. Returns the distinct existing project tags for a department so
 * the review form can suggest them (and so a tag created once is reusable).
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { expenseSubmissions } from "@/lib/db/schema";
import { requireApiAdmin } from "@/lib/auth/requireApiAdmin";
import { isNextRedirectError, errorMessage } from "@/lib/api-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const guard = await requireApiAdmin();
    if (!guard.ok) return guard.response;

    const department = new URL(req.url).searchParams.get("department");
    const where = department
      ? and(
          eq(expenseSubmissions.department, department),
          isNotNull(expenseSubmissions.project_tag),
        )
      : isNotNull(expenseSubmissions.project_tag);

    const rows = await db
      .selectDistinct({ tag: expenseSubmissions.project_tag })
      .from(expenseSubmissions)
      .where(where)
      .orderBy(expenseSubmissions.project_tag)
      .limit(200);

    const tags = rows.map((r) => r.tag).filter(Boolean) as string[];
    return NextResponse.json({ success: true, data: tags });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    return NextResponse.json(
      { success: false, error: { message: errorMessage(e) } },
      { status: 500 },
    );
  }
}
