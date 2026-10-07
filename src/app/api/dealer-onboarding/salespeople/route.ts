import { NextResponse } from "next/server";
import { listSalespeople } from "@/lib/onboarding/salesperson";

// GET — the salesperson dropdown on the dealer onboarding wizard (ID 66).
//
// Open like the wizard itself (a dealer fills it in before any login exists),
// so it returns a name and role only: no email, no phone. The save and submit
// routes look the rest up from the id.
export const dynamic = "force-dynamic";

export async function GET() {
    try {
        const salespeople = await listSalespeople();
        return NextResponse.json({ success: true, salespeople });
    } catch (err) {
        console.error("[DEALER-ONBOARDING] salespeople list failed:", err);
        return NextResponse.json({ success: false, salespeople: [] }, { status: 500 });
    }
}
