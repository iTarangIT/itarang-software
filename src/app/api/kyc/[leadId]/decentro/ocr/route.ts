import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { extractDocumentOcr, OcrDocType } from '@/lib/decentro';
import { db } from '@/lib/db';
import { kycVerifications } from '@/lib/db/schema';
import { createWorkflowId } from '@/lib/kyc/admin-workflow';

const ALLOWED_TYPES: OcrDocType[] = ['PAN', 'AADHAAR', 'DRIVING_LICENSE', 'VOTERID'];

const ocrRequestSchema = z.object({
    document_side: z.preprocess(
        (v) => {
            if (typeof v !== 'string') return undefined;
            const up = v.trim().toUpperCase();
            return up === '' ? undefined : up;
        },
        z.enum(['FRONT', 'BACK']).optional(),
    ),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

        const { leadId } = await params;

        const formData = await req.formData();
        const file = formData.get('file') as File | null;
        const document_type = (formData.get('document_type') as string)?.toUpperCase() as OcrDocType;
        const parsedRequest = ocrRequestSchema.safeParse({
            document_side: formData.get('document_side') ?? undefined,
        });
        if (!parsedRequest.success) {
            return NextResponse.json(
                { success: false, error: 'document_side must be FRONT or BACK' },
                { status: 400 },
            );
        }
        const side = parsedRequest.data.document_side;

        if (!file) return NextResponse.json({ success: false, error: 'file is required' }, { status: 400 });
        if (!ALLOWED_TYPES.includes(document_type)) {
            return NextResponse.json({ success: false, error: `document_type must be one of: ${ALLOWED_TYPES.join(', ')}` }, { status: 400 });
        }
        if (file.size > 6 * 1024 * 1024) {
            return NextResponse.json({ success: false, error: 'File must be under 6MB' }, { status: 400 });
        }

        const blob = new Blob([await file.arrayBuffer()], { type: file.type });
        const decentroRes = await extractDocumentOcr(document_type, blob, file.name, side);

        // Persist raw Decentro response so the provider payload is auditable
        // later. Non-fatal — we don't want to block OCR return on an insert.
        try {
            const now = new Date();
            await db.insert(kycVerifications).values({
                id: createWorkflowId('KYCVER', now),
                lead_id: leadId,
                verification_type: 'ocr',
                applicant: 'primary',
                status: decentroRes.responseStatus === 'SUCCESS' ? 'success' : 'failed',
                api_provider: 'decentro_ocr',
                api_request: { document_type, document_side: side, file_name: file.name },
                api_response: decentroRes as unknown as Record<string, unknown>,
                submitted_at: now,
                completed_at: now,
            });
        } catch (persistErr) {
            console.error('[kyc/ocr] kyc_verifications insert failed:', persistErr);
        }

        return NextResponse.json({
            success: decentroRes.responseStatus === 'SUCCESS',
            responseStatus: decentroRes.responseStatus,
            message: decentroRes.message,
            data: decentroRes.data || null,
        });
    } catch (error) {
        console.error('Decentro OCR error:', error);
        return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 });
    }
}
