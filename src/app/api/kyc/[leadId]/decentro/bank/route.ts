import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { executeBankVerification } from '@/lib/kyc/bank-verification';

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

        const { leadId } = await params;
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

        return NextResponse.json(result);
    } catch (error) {
        console.error('Decentro bank verify error:', error);
        return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 });
    }
}
