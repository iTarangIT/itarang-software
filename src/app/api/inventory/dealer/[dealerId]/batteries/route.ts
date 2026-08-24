import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-utils";
import { listDealerBatteries } from "@/lib/inventory/dealer-stock";

// BRD V2 §2.3 — dealer battery inventory list for the product picker.
// Filters: dealer_id + asset_type=Battery + status=available.
// Reserved/Dispatched/Sold are hidden — the picker only offers selectable stock.
// Optional query params: category, subCategory, includeSerials.
// Sort: oem_invoice_date ASC (oldest first — BRD ageing priority rule).
//
// The query lives in `src/lib/inventory/dealer-stock.ts` so the WhatsApp Step-5
// picker offers exactly the same stock, in the same order, as this screen.

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ dealerId: string }> },
) {
  try {
    const user = await requireAuth();
    const { dealerId } = await params;

    // Dealer can only view their own inventory; admins can view any dealer's.
    if (user.role === "dealer" && user.dealer_id !== dealerId) {
      return NextResponse.json(
        { success: false, error: { message: "Access denied" } },
        { status: 403 },
      );
    }

    const { searchParams } = new URL(req.url);
    const data = await listDealerBatteries({
      dealerId,
      category: searchParams.get("category"),
      subCategory: searchParams.get("subCategory"),
      includeSerials: (searchParams.get("includeSerials") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("[Dealer Batteries] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to load batteries";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
