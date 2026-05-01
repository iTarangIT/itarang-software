import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, productSelections } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";

// E-103 (Sync Audit G-05) — GET /api/product-selections/{id}
// Returns the renamed product_selections.model_number column under JSON key
// 'modelNumber'. The 'subCategory' alias was removed per BRD; callers must
// migrate to 'modelNumber'.

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole([
      "admin",
      "ceo",
      "business_head",
      "sales_head",
      "sales_manager",
      "sales_executive",
      "finance_controller",
      "dealer",
    ]);
    const { id } = await params;

    const [selection] = await db
      .select()
      .from(productSelections)
      .where(eq(productSelections.id, id))
      .limit(1);

    if (!selection) {
      return NextResponse.json(
        { success: false, error: { message: "Product selection not found" } },
        { status: 404 },
      );
    }

    // Dealer-scoped access check: a dealer can only read their own selections.
    if (user.role === "dealer") {
      const [lead] = await db
        .select({ dealer_id: leads.dealer_id })
        .from(leads)
        .where(eq(leads.id, selection.lead_id))
        .limit(1);
      if (!lead || lead.dealer_id !== user.dealer_id) {
        return NextResponse.json(
          { success: false, error: { message: "Access denied" } },
          { status: 403 },
        );
      }
    }

    return NextResponse.json({
      id: selection.id,
      leadId: selection.lead_id,
      modelNumber: selection.model_number,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load product selection";
    const status = message.toLowerCase().includes("unauthor") ? 401 : 500;
    return NextResponse.json(
      { success: false, error: { message } },
      { status },
    );
  }
}
