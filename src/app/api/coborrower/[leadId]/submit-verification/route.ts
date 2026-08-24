import { NextRequest, NextResponse } from 'next/server';

import { submitCoBorrowerVerification } from '@/lib/kyc/coborrower-submit';

// BRD §2.9.3 step 5 — When dealer submits Step 3 (co-borrower KYC), the
// lead must move to 'pending_itarang_reverification' and a high-priority
// row must land in adminVerificationQueue so the admin sees it.
//
// The implementation moved to src/lib/kyc/coborrower-submit.ts (E-264) so the
// WhatsApp bot — which has no Supabase session and therefore cannot call this
// route — drives exactly the same writes. This handler is now the HTTP wrapper.

export async function POST(_req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;
        const result = await submitCoBorrowerVerification(leadId);
        return NextResponse.json({ success: true, ...result });
    } catch (error) {
        console.error('[Co-borrower Submit Verification] Error:', error);
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
