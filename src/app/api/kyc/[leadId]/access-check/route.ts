import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;
        const lead = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);

        if (!lead.length) {
            return NextResponse.json({ success: false, allowed: false, message: 'Lead not found' });
        }

        const l = lead[0];

        // Access condition: lead must exist and be a hot lead
        const allowed = l.interest_level === 'hot' && l.status !== 'ABANDONED';

        return NextResponse.json({
            success: true,
            allowed,
            lead: allowed ? {
                id: l.id,
                reference_id: l.reference_id,
                full_name: l.full_name,
                phone: l.phone,
                asset_model: l.asset_model,
                payment_method: l.payment_method,
                consent_status: l.consent_status,
                kyc_status: l.kyc_status,
                workflow_step: l.workflow_step,
            } : null,
        });
    } catch (error) {
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
