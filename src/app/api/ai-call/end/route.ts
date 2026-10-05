import { endCallSession } from '@/lib/ai-call-service';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { z } from 'zod';
import { LEADS_OVERSIGHT_ROLES } from "@/lib/leads/access";
import { requireRole } from "@/lib/auth-utils";

const endSchema = z.object({
    sessionId: z.string().min(1),
    transcript: z.string().min(1),
});

export const POST = withErrorHandler(async (req: Request) => {
    // ID 118: signed in, with a role that reaches this screen.
    await requireRole([...LEADS_OVERSIGHT_ROLES]);
    const body = await req.json();
    const result = endSchema.safeParse(body);

    if (!result.success) {
        return errorResponse(`Validation Error: ${result.error.issues[0].message}`, 400);
    }

    const { sessionId, transcript } = result.data;

    const summary = await endCallSession(sessionId, transcript);

    return successResponse(summary);
});
