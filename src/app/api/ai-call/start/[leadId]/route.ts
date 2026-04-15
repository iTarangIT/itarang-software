import { startCallSession } from '@/lib/ai-call-service';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { NextResponse } from 'next/server';

export const POST = withErrorHandler(async (
    req: Request,
    { params }: { params: { leadId: string } }
) => {
    try {
        const { leadId } = await params;

        if (!leadId) {
            return errorResponse('Lead ID is required', 400);
        }

        const sessionId = await startCallSession(leadId);

        return successResponse({
            sessionId,
            message: 'Call session initiated successfully'
        });
    } catch (error: any) {
        return errorResponse(error.message, 400);
    }
});
