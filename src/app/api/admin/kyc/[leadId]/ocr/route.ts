import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { runKycOcr } from '@/lib/kyc/ocr-extract';

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const { leadId } = await params;
    const body = await req.json();
    const doc_type: string = typeof body.doc_type === 'string' ? body.doc_type : '';
    // doc_for filters by applicant: 'customer' = primary, 'borrower' = co-borrower.
    // Default 'customer' keeps existing callers (that don't send doc_for) on the
    // primary doc — backward compatible with the autofill button before this fix.
    const doc_for: string = typeof body.doc_for === 'string' ? body.doc_for : 'customer';

    const { status, ...result } = await runKycOcr(leadId, { docType: doc_type, docFor: doc_for });
    return NextResponse.json(result, { status: status ?? 200 });
}
