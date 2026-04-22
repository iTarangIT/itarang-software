import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { faceMatch } from '@/lib/decentro';
import { db } from '@/lib/db';
import { kycVerifications } from '@/lib/db/schema';
import { createWorkflowId } from '@/lib/kyc/admin-workflow';

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

        const { leadId } = await params;

        const formData = await req.formData();
        const image1 = formData.get('image1') as File | null;
        const image2 = formData.get('image2') as File | null;

        if (!image1 || !image2) {
            return NextResponse.json({ success: false, error: 'Both image1 and image2 are required' }, { status: 400 });
        }
        if (image1.size > 6 * 1024 * 1024 || image2.size > 6 * 1024 * 1024) {
            return NextResponse.json({ success: false, error: 'Each image must be under 6MB' }, { status: 400 });
        }

        const blob1 = new Blob([await image1.arrayBuffer()], { type: image1.type });
        const blob2 = new Blob([await image2.arrayBuffer()], { type: image2.type });

        const decentroRes = await faceMatch(blob1, blob2);
        const success = decentroRes.responseStatus === 'SUCCESS';

        // Persist raw Decentro response for audit. Non-fatal.
        try {
            const now = new Date();
            const score = decentroRes.data?.match_score;
            await db.insert(kycVerifications).values({
                id: createWorkflowId('KYCVER', now),
                lead_id: leadId,
                verification_type: 'face_match',
                applicant: 'primary',
                status: success ? 'success' : 'failed',
                api_provider: 'decentro_face_match',
                match_score: typeof score === 'number' ? String(score) : null,
                api_response: decentroRes as unknown as Record<string, unknown>,
                submitted_at: now,
                completed_at: now,
            });
        } catch (persistErr) {
            console.error('[kyc/face-match] kyc_verifications insert failed:', persistErr);
        }

        return NextResponse.json({
            success,
            responseStatus: decentroRes.responseStatus,
            message: decentroRes.message,
            match_score: decentroRes.data?.match_score ?? null,
            is_match: decentroRes.data?.is_match ?? null,
            data: decentroRes.data || null,
        });
    } catch (error) {
        console.error('Decentro face match error:', error);
        return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 });
    }
}
