import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { executePanVerification } from '@/lib/kyc/pan-verification';
import { requireLeadAccess } from '@/lib/auth/requireLeadAccess';
import { isMaskedPan } from '@/lib/kyc/panMask';

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

        const { leadId } = await params;
        // ID 119: signed in AND this lead is the caller's (a dealer's own lead, or back office).
        const leadGate = await requireLeadAccess(leadId);
        if (!leadGate.ok) return leadGate.response;
        const { pan_number, dob, document_type } = await req.json();
        // ID 119 / 166: a role that may not see the full PAN only has the mask.
        if (isMaskedPan(pan_number)) {
            return NextResponse.json(
                { success: false, error: 'The full PAN is hidden for your role. Ask the lead owner, the Sales Head or Admin to verify it.' },
                { status: 403 },
            );
        }

        const result = await executePanVerification(leadId, {
            panNumber: pan_number,
            documentType: document_type,
            dob,
        });

        if ('error' in result) {
            return NextResponse.json(
                { success: false, error: result.error },
                { status: result.status },
            );
        }

        return NextResponse.json(result);
    } catch (error) {
        console.error('Decentro PAN verification error:', error);
        return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 });
    }
}
