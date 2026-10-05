import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { requireLeadAccess } from "@/lib/auth/requireLeadAccess";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    // ID 118: signed in, and this lead is the caller's to touch (a dealer's own lead, or back office).
    const leadGate = await requireLeadAccess((await params).leadId);
    if (!leadGate.ok) return leadGate.response;
    try {
        const { leadId } = await params;
        const { payment_method } = await req.json();

        if (!['upfront', 'finance'].includes(payment_method)) {
            return NextResponse.json({ success: false, error: { message: 'Invalid payment method' } }, { status: 400 });
        }

        await db.update(leads)
            .set({ payment_method, updated_at: new Date() })
            .where(eq(leads.id, leadId));

        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
