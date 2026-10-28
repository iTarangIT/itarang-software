/**
 * GET /api/kyc/[leadId]/timeline — the file's KYC action log (who did what,
 * when), newest first. Whoever may open the lead may read it: iTarang staff
 * and the dealer who owns it (requireLeadAccess).
 *
 * ID 201 #6: the owning dealer sees "iTarang team" for every iTarang person
 * (staff and the house login); the house login and staff see the names.
 */
import { NextResponse } from "next/server";

import { requireLeadAccess } from "@/lib/auth/requireLeadAccess";
import { kycTimeline } from "@/lib/kyc/kycEventLog";
import { kycWhoFor } from "@/lib/kyc/kycEventText";
import { houseDealerCode } from "@/lib/leads/dealerByMobile";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ leadId: string }> }) {
    const { leadId } = await params;
    const access = await requireLeadAccess(leadId);
    if (!access.ok) return access.response;
    try {
        const [rows, house] = await Promise.all([kycTimeline(leadId), houseDealerCode()]);
        const u = access.user;
        const owningDealer = (u.role ?? "").toLowerCase() === "dealer" && !(house && u.dealer_id === house);
        const viewer = owningDealer ? "owning_dealer" : "itarang";
        return NextResponse.json({
            success: true,
            data: {
                viewer,
                rows: rows.map((r) => {
                    const byName = kycWhoFor(viewer, r);
                    // A redacted line carries no role either ("Sales Head" would name the person).
                    return byName === r.byName ? r : { ...r, byName, byRole: null };
                }),
            },
        });
    } catch (err) {
        console.error(`[kyc/timeline] ${leadId} failed:`, err);
        return NextResponse.json({ success: false, error: { message: "Could not load the KYC history" } }, { status: 500 });
    }
}
