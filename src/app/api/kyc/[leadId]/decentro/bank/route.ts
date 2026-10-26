import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { executeBankVerification } from '@/lib/kyc/bank-verification';
import { requireLeadAccess } from '@/lib/auth/requireLeadAccess';
import { requireLeadWriter } from '@/lib/leads/actForDealerGuard';
import { recordKycStep } from '@/lib/kyc/kycEventLog';

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

        const { leadId } = await params;
        // ID 119: signed in AND this lead is the caller's (a dealer's own lead, or back office).
        const leadGate = await requireLeadAccess(leadId);
        if (!leadGate.ok) return leadGate.response;
        // ID 183: a change to the file — its own dealer, or Admin / Sales Head acting for the dealer.
        const writer = await requireLeadWriter(leadId, req, leadGate.user);
        if (!writer.ok) return writer.response;
        const { account_number, ifsc, name, perform_name_match, validation_type } = await req.json();

        const result = await executeBankVerification(leadId, {
            accountNumber: account_number,
            ifsc,
            name,
            performNameMatch: perform_name_match,
            validationType: validation_type,
        });

        if ('error' in result) {
            return NextResponse.json(
                { success: false, error: result.error },
                { status: result.status },
            );
        }

        await recordKycStep(writer.actor, 'ran the bank account check');
        return NextResponse.json(result);
    } catch (error) {
        console.error('Decentro bank verify error:', error);
        return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 });
    }
}
