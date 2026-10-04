/**
 * E-321 — GET /api/dashboard/ceo/invoices/accounts-search?q=
 *
 * The account picker behind "Link to account" on the unmatched-invoices work
 * list (tracker ID 69). Up to 20 dealer accounts whose name, GSTIN or id
 * contains `q`; with no `q`, the first 20 by name.
 */
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth-utils";
import { errorMessage, isNextRedirectError } from "@/lib/api-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["ceo", "admin", "finance_controller"]);
const LIMIT = 20;

export async function GET(req: NextRequest) {
  try {
    const user = await requireAuth();
    if (!ALLOWED_ROLES.has((user.role || "").toLowerCase())) {
      return NextResponse.json(
        { success: false, error: { message: "FORBIDDEN" } },
        { status: 403 },
      );
    }

    const q = (req.nextUrl.searchParams.get("q") || "").trim().slice(0, 100);
    // Escape LIKE wildcards so a typed "%" or "_" is matched literally.
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    // GSTINs are stored upper-case without spaces; match the typed text the same way.
    const gstinLike = `%${q.replace(/\s+/g, "").toUpperCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

    const where = q
      ? sql`WHERE a.business_entity_name ILIKE ${like}
               OR a.id ILIKE ${like}
               OR upper(a.gstin) LIKE ${gstinLike}`
      : sql``;

    const res = await db.execute(sql`
      SELECT a.id, a.business_entity_name, a.gstin, a.city
        FROM accounts a
        ${where}
       ORDER BY a.business_entity_name ASC
       LIMIT ${LIMIT}
    `);
    const rows = (Array.isArray(res)
      ? res
      : ((res as { rows?: unknown[] }).rows ?? [])) as Array<{
      id: string;
      business_entity_name: string;
      gstin: string | null;
      city: string | null;
    }>;

    return NextResponse.json({ success: true, data: rows });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    return NextResponse.json(
      { success: false, error: { message: errorMessage(e) } },
      { status: 500 },
    );
  }
}
