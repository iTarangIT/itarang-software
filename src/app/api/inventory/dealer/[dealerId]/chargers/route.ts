import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-utils";
import { listDealerChargers } from "@/lib/inventory/dealer-stock";

// BRD V2 §2.3 — dealer charger inventory list for the product picker.
//
// Status filter: available only — the picker only offers selectable stock.
//
// Compatibility:
//   A strict products.voltage_v = batteryVoltage filter was tried previously,
//   but real inventories label battery and charger voltages on different
//   conventions (e.g. a 51V LFP pack pairs with a 58.4V charger), so the
//   strict match returned zero chargers in practice and stranded dealers with
//   "No chargers available" even when stock existed. Until a real per-product
//   compatibility table exists, we list every charger in the dealer's inventory
//   for the lead's category and let the dealer pair them. The
//   `?batteryVoltage=N` query param is accepted for forwards compatibility but
//   is ignored server-side.
//
// The query lives in `src/lib/inventory/dealer-stock.ts` so the WhatsApp Step-5
// picker offers exactly the same stock as this screen.

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ dealerId: string }> },
) {
  try {
    const user = await requireAuth();
    const { dealerId } = await params;

    if (user.role === "dealer" && user.dealer_id !== dealerId) {
      return NextResponse.json(
        { success: false, error: { message: "Access denied" } },
        { status: 403 },
      );
    }

    const { searchParams } = new URL(req.url);
    const data = await listDealerChargers({
      dealerId,
      category: searchParams.get("category"),
      batteryVoltage: searchParams.get("batteryVoltage"),
      includeSerials: (searchParams.get("includeSerials") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("[Dealer Chargers] Error:", error);
    const message = error instanceof Error ? error.message : "Failed to load chargers";
    return NextResponse.json(
      { success: false, error: { message } },
      { status: 500 },
    );
  }
}
