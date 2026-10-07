import { startCallSession } from '@/lib/ai-call-service';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { NextResponse } from 'next/server';
import { LEADS_OVERSIGHT_ROLES } from "@/lib/leads/access";
import { requireRole } from "@/lib/auth-utils";

export const POST = withErrorHandler(async (
    req: Request,
    { params }: { params: Promise<{ leadId: string }> }
) => {
    // ID 118: signed in, with a role that reaches this screen.
    await requireRole([...LEADS_OVERSIGHT_ROLES]);
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
