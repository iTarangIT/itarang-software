import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { leads, personalDetails } from '@/lib/db/schema';
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

        // Access condition: lead must not be abandoned, must be Hot, and must have a finance payment method.
        // Warm/Cold leads are parked at Step 1 until promoted to Hot — they cannot enter KYC.
        const isFinance = FINANCE_METHODS.includes(l.payment_method || '');
        const isHot = l.interest_level === 'hot';
        const isNotAbandoned = l.status !== 'ABANDONED';
        const allowed = isNotAbandoned && isFinance && isHot;

        // Pull aadhaar_no / pan_no from personal_details — those don't live
        // on the leads table. Other primary applicant fields (dob, addresses,
        // father / husband) live on leads itself.
        const personal = await db
            .select()
            .from(personalDetails)
            .where(eq(personalDetails.lead_id, l.id))
            .limit(1);
        const pd = personal[0];

        const leadData = {
            id: l.id,
            reference_id: l.reference_id,
            full_name: l.full_name,
            owner_name: l.owner_name,
            father_or_husband_name: l.father_or_husband_name ?? pd?.father_husband_name ?? null,
            phone: l.phone,
            owner_contact: l.owner_contact,
            dob: (l.dob ?? pd?.dob) ?? null,
            permanent_address: l.permanent_address ?? pd?.permanent_address ?? null,
            current_address: l.current_address ?? pd?.local_address ?? null,
            local_address: l.local_address ?? pd?.local_address ?? null,
            aadhaar_no: pd?.aadhaar_no ?? null,
            pan_no: pd?.pan_no ?? null,
            asset_model: l.asset_model,
            asset_category: null, // column not present on current leads schema
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
                ? !isNotAbandoned
                    ? 'This lead has been abandoned.'
                    : !isHot
                        ? 'Step 2 (KYC) is only available for Hot leads. Promote this lead to Hot to proceed.'
                        : 'KYC is only available for leads with a finance payment method.'
                : undefined,
        });
    } catch (error) {
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
