// LinkedIn Outreach — admin reply. Pressing Send is the approval (doc §6.1);
// the reply is queued and sent by the worker under the same pacing.
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { queueReply } from "@/lib/linkedin/services/inbox";

export const dynamic = "force-dynamic";

const Body = z.object({ body: z.string().trim().min(1).max(8000), attachment_id: z.string().uuid().optional().nullable() });

export const POST = withErrorHandler(async (req: Request, { params }: { params: Promise<{ conversationId: string }> }) => {
  const { conversationId } = await params;
  const user = await requireRole([...LINKEDIN_ROLES]);
  const b = Body.parse(await req.json());
  return successResponse(await queueReply(conversationId, b.body, b.attachment_id ?? null, user.id), 202);
});
