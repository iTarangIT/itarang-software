/**
 * ID 89 — GET /api/dashboard/ceo/receivables-ageing
 *
 * The ageing buckets (0–30, 31–60, 61–90, 90+ days since the invoice date) of
 * everything still owed to us, for the strip on "Revenue & costs". Built from
 * the same listReceivables() the /ceo/receivables page renders, so the strip
 * and that page add up to the same rupee. All-time, as of today: a receivable
 * is not windowed by the page's period control.
 */
import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";
import { ageReceivables, listReceivables } from "@/lib/dashboard/receivables";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same roles as the /ceo/receivables page.
const ALLOWED_ROLES = new Set(["ceo", "admin"]);

export async function GET() {
  try {
    const user = await requireAuth();
    if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) {
      return NextResponse.json(
        { success: false, error: { message: "FORBIDDEN" } },
        { status: 403 },
      );
    }
    return NextResponse.json({ success: true, data: ageReceivables(await listReceivables()) });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    return NextResponse.json(
      { success: false, error: { message: errorMessage(e) } },
      { status: 500 },
    );
  }
}
