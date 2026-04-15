import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { executePanVerification } from '@/lib/kyc/pan-verification';

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

        const { leadId } = await params;
        const { pan_number, dob, document_type } = await req.json();

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
