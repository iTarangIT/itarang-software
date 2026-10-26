/**
 * GET /api/kyc/[leadId]/timeline — the file's KYC action log (who did what,
 * when), newest first. Whoever may open the lead may read it: iTarang staff
 * and the dealer who owns it (requireLeadAccess).
 */
import { NextResponse } from "next/server";

import { requireLeadAccess } from "@/lib/auth/requireLeadAccess";
import { kycTimeline } from "@/lib/kyc/kycEventLog";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ leadId: string }> }) {
    const { leadId } = await params;
    const access = await requireLeadAccess(leadId);
    if (!access.ok) return access.response;
    try {
        return NextResponse.json({ success: true, data: { rows: await kycTimeline(leadId) } });
    } catch (err) {
        console.error(`[kyc/timeline] ${leadId} failed:`, err);
        return NextResponse.json({ success: false, error: { message: "Could not load the KYC history" } }, { status: 500 });
    }
}
