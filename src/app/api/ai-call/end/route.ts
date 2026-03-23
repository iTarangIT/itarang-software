import { endCallSession } from '@/lib/ai-call-service';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { z } from 'zod';

const endSchema = z.object({
    sessionId: z.string().min(1),
    transcript: z.string().min(1),
});

export const POST = withErrorHandler(async (req: Request) => {
    const body = await req.json();
    const result = endSchema.safeParse(body);

    if (!result.success) {
        return errorResponse(`Validation Error: ${result.error.issues[0].message}`, 400);
    }

    const { sessionId, transcript } = result.data;

    const summary = await endCallSession(sessionId, transcript);

    return successResponse(summary);
});
