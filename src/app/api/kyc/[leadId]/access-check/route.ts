import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { leads } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

const FINANCE_METHODS = ['finance', 'other_finance', 'dealer_finance'];

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;
        const lead = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);

        if (!lead.length) {
            return NextResponse.json({ success: false, allowed: false, message: 'Lead not found' });
        }

        const l = lead[0];

        // Access condition: lead must not be abandoned, and must have a finance payment method
        const isFinance = FINANCE_METHODS.includes(l.payment_method || '');
        const isNotAbandoned = l.status !== 'ABANDONED';
        const allowed = isNotAbandoned && isFinance;

        const leadData = {
            id: l.id,
            reference_id: l.reference_id,
            full_name: l.full_name,
            owner_name: l.owner_name,
            phone: l.phone,
            owner_contact: l.owner_contact,
            asset_model: l.asset_model,
            asset_category: l.asset_category,
            payment_method: l.payment_method,
            interest_level: l.interest_level,
            consent_status: l.consent_status,
            kyc_status: l.kyc_status,
            workflow_step: l.workflow_step,
            coupon_code: l.coupon_code,
            coupon_status: l.coupon_status,
            lead_status: l.lead_status,
            has_co_borrower: l.has_co_borrower,
            kyc_draft_data: l.kyc_draft_data,
            draft_updated_at: l.updated_at,
        };

        return NextResponse.json({
            success: true,
            allowed,
            lead: leadData,
            message: !allowed
                ? !isFinance
                    ? 'KYC is only available for leads with a finance payment method.'
                    : 'This lead has been abandoned.'
                : undefined,
        });
    } catch (error) {
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
