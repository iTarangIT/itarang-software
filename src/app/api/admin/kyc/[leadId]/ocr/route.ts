import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { runKycOcr } from '@/lib/kyc/ocr-extract';
import { requireLeadAccess } from '@/lib/auth/requireLeadAccess';
import { maskAadhaarDeep } from '@/lib/kyc/aadhaarMask';
import { maskPanDeep } from '@/lib/kyc/panMask';

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const { leadId } = await params;
    // ID 119: a login alone let anyone OCR any lead's KYC documents (and read
    // the Aadhaar / PAN back). Back office, or the lead's own dealer.
    const access = await requireLeadAccess(leadId);
    if (!access.ok) return access.response;
    const body = await req.json();
    const doc_type: string = typeof body.doc_type === 'string' ? body.doc_type : '';
    // doc_for filters by applicant: 'customer' = primary, 'borrower' = co-borrower.
    // Default 'customer' keeps existing callers (that don't send doc_for) on the
    // primary doc — backward compatible with the autofill button before this fix.
    const doc_for: string = typeof body.doc_for === 'string' ? body.doc_for : 'customer';

    const { status, ...result } = await runKycOcr(leadId, { docType: doc_type, docFor: doc_for });
    // ID 119: the OCR'd Aadhaar number is saved server-side, never sent back in
    // full; the PAN only to Admin, Sales Head, CEO and the lead's owner.
    const safe = access.user.fullIds ? maskAadhaarDeep(result) : maskPanDeep(maskAadhaarDeep(result));
    return NextResponse.json(safe, { status: status ?? 200 });
}
