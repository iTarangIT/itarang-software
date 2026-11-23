// LinkedIn Outreach — one campaign: tracking detail (GET), edit (PATCH).
// Editing the message, note or attachment voids the approval (doc §6.1).
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { campaignDetail, updateCampaign } from "@/lib/linkedin/services/campaigns";

export const dynamic = "force-dynamic";

const Body = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  template: z.string().max(8000).optional(),
  invite_note: z.string().max(300).optional().nullable(),
  attachment_id: z.string().uuid().optional().nullable(),
});

export const GET = withErrorHandler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  await requireRole([...LINKEDIN_ROLES]);
  return successResponse(await campaignDetail(id));
});

export const PATCH = withErrorHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const user = await requireRole([...LINKEDIN_ROLES]);
  const b = Body.parse(await req.json());
  return successResponse(
    await updateCampaign(
      id,
      { name: b.name, template: b.template, inviteNote: b.invite_note, attachmentId: b.attachment_id },
      user.id,
    ),
  );
});
