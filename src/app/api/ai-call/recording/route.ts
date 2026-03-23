import { storeCallRecording } from '@/lib/ai-call-service';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { z } from 'zod';

const recordingSchema = z.object({
    sessionId: z.string().min(1),
    recordingUrl: z.string().url(),
    duration: z.number().int().positive(),
});

export const POST = withErrorHandler(async (req: Request) => {
    const body = await req.json();
    const result = recordingSchema.safeParse(body);

    if (!result.success) {
        return errorResponse(`Validation Error: ${result.error.issues[0].message}`, 400);
    }

    const { sessionId, recordingUrl, duration } = result.data;

    await storeCallRecording(sessionId, recordingUrl, duration);

    return successResponse({ message: 'Recording metadata stored successfully' });
});
