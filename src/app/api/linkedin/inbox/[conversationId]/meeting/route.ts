// LinkedIn Outreach — "Meeting scheduled" (E-398). The Sales Head marks it;
// that mark is what the Meetings KPI counts. { meeting: true | false } sets or
// clears it; { dismiss_hint: true } hides the AI's "looks like a meeting" nudge.
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { dismissMeetingHint, setMeeting } from "@/lib/linkedin/services/extras";

export const dynamic = "force-dynamic";

const Body = z.union([z.object({ meeting: z.boolean() }), z.object({ dismiss_hint: z.literal(true) })]);

export const POST = withErrorHandler(async (req: Request, { params }: { params: Promise<{ conversationId: string }> }) => {
  const { conversationId } = await params;
  const user = await requireRole([...LINKEDIN_ROLES]);
  const b = Body.parse(await req.json());
  if ("dismiss_hint" in b) {
    await dismissMeetingHint(conversationId);
    return successResponse({ dismissed: true });
  }
  return successResponse(await setMeeting(conversationId, b.meeting, user.id));
});
