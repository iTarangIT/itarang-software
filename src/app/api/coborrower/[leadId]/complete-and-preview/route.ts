import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireLeadAccess } from "@/lib/auth/requireLeadAccess";

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    // ID 118: signed in, and this lead is the caller's to touch (a dealer's own lead, or back office).
    const leadGate = await requireLeadAccess((await params).leadId);
    if (!leadGate.ok) return leadGate.response;
    try {
        const { leadId } = await params;

        await db.update(leads)
            .set({
                interim_step_status: 'completed',
                workflow_step: 3,
                updated_at: new Date(),
            })
            .where(eq(leads.id, leadId));

        return NextResponse.json({ success: true, nextStep: 3 });
    } catch (error) {
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
