import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireLeadAccess } from "@/lib/auth/requireLeadAccess";
import { recordActorStep, requireLeadWriter } from "@/lib/leads/actForDealerGuard";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    // ID 118: signed in, and this lead is the caller's to touch (a dealer's own lead, or back office).
    const leadGate = await requireLeadAccess((await params).leadId);
    if (!leadGate.ok) return leadGate.response;
    // ID 183: a change to the file — its own dealer (stamps the dealer's
    // action), or Admin / Sales Head acting for the dealer.
    const writer = await requireLeadWriter((await params).leadId, req, leadGate.user);
    if (!writer.ok) return writer.response;
    try {
        const { leadId } = await params;
        const body = await req.json();

        await db.update(leads)
            .set({
                kyc_draft_data: { ...body, interim_step: true },
                interim_step_status: 'pending',
                updated_at: new Date(),
            })
            .where(eq(leads.id, leadId));

        // ID 183 (21 Oct): an autosave — one "Done by" line per person per 30 minutes.
        await recordActorStep(writer.actor, 'saved the co-borrower details (draft)', {}, { coalesce: true });
        return NextResponse.json({ success: true, savedAt: new Date().toISOString() });
    } catch (error) {
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
