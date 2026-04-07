import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth-utils';
import { runLeadQualification } from '@/lib/ai/langgraph/lead-qualification-graph';

export async function POST(req: NextRequest) {
    try {
        await requireRole(['ceo']);
        const { leadId } = await req.json();

        if (!leadId) {
            return NextResponse.json({ success: false, error: { message: 'leadId required' } }, { status: 400 });
        }

        const result = await runLeadQualification(leadId);
        return NextResponse.json({ success: true, data: result });
    } catch (error) {
        console.error('[AI Dialer Score] Error:', error);
        const message = error instanceof Error ? error.message : 'Server error';
        return NextResponse.json({ success: false, error: { message } }, { status: 500 });
    }
}
