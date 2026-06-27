import { NextRequest, NextResponse } from 'next/server';
import {
    buildDealerEditLockMessage,
    isDealerKycEditsLocked,
} from '@/lib/kyc/admin-workflow';
import { storeSignedConsent, type ConsentFor } from '@/lib/kyc/consent-service';

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;

        if (await isDealerKycEditsLocked(leadId)) {
            return NextResponse.json(
                { success: false, error: { message: buildDealerEditLockMessage() } },
                { status: 409 }
            );
        }

        const formData = await req.formData();
        const file = formData.get('file') as File;
        const consentFor = String(formData.get('consent_for') || 'customer') as ConsentFor;

        if (!file) {
            return NextResponse.json({ success: false, error: { message: 'File is required' } }, { status: 400 });
        }
        if (file.type !== 'application/pdf') {
            return NextResponse.json({ success: false, error: { message: 'Only PDF files are accepted' } }, { status: 400 });
        }
        if (file.size > 10 * 1024 * 1024) {
            return NextResponse.json({ success: false, error: { message: 'File must be less than 10MB' } }, { status: 400 });
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const result = await storeSignedConsent({ leadId, buffer, consentFor });
        if (!result.ok) {
            return NextResponse.json({ success: false, error: { message: result.error } }, { status: result.status });
        }

        return NextResponse.json({ success: true, fileUrl: result.fileUrl });
    } catch (error) {
        console.error('[Upload Signed Consent] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
