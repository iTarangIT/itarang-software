// GET /api/admin/nbfc/eligible-for-assignment
//
// Lists every NBFC with status in ('approved','active') — the set eligible
// for dealer assignment per E-012's gate. Includes a count of active loan
// products per NBFC so the admin picker can hide NBFCs with no shippable
// product (those wouldn't surface on the dealer's Section G anyway).
//
// Used by /admin/dealer-verification/[dealerId]/nbfcs.

import { NextRequest, NextResponse } from "next/server";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfc, nbfcLoanProducts } from "@/lib/db/schema";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";

export async function GET(req: NextRequest) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;

  try {
    const nbfcRows = await db
      .select({
        id: nbfc.id,
        nbfc_id: nbfc.nbfc_id,
        short_name: nbfc.short_name,
        legal_name: nbfc.legal_name,
        status: nbfc.status,
      })
      .from(nbfc)
      .where(inArray(nbfc.status, ["approved", "active"]));

    if (nbfcRows.length === 0) {
      return NextResponse.json({ success: true, items: [] });
    }

    const productCounts = await db
      .select({
        nbfc_id: nbfcLoanProducts.nbfc_id,
        active_count: sql<number>`count(*)::int`,
      })
      .from(nbfcLoanProducts)
      .where(eq(nbfcLoanProducts.status, "active"))
      .groupBy(nbfcLoanProducts.nbfc_id);

    const countByNbfc = new Map(
      productCounts.map((r) => [r.nbfc_id, r.active_count]),
    );

    const items = nbfcRows
      .map((n) => ({
        id: n.id,
        nbfcId: n.nbfc_id,
        shortName: n.short_name,
        legalName: n.legal_name,
        status: n.status,
        activeLoanProductCount: countByNbfc.get(n.id) ?? 0,
      }))
      .sort((a, b) => a.shortName.localeCompare(b.shortName));

    return NextResponse.json({ success: true, items });
  } catch (err) {
    console.error("[/api/admin/nbfc/eligible-for-assignment] error", err);
    return NextResponse.json(
      { success: false, message: "Failed to load eligible NBFCs" },
      { status: 500 },
    );
  }
}
