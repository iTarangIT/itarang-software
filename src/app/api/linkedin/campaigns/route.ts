// LinkedIn Outreach — campaigns: list, create a draft.
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LI_CATEGORIES } from "@/lib/linkedin/categories";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { createCampaign, listCampaigns } from "@/lib/linkedin/services/campaigns";

export const dynamic = "force-dynamic";

const Body = z.object({
  name: z.string().trim().min(1).max(150),
  account_id: z.string().uuid(),
  template: z.string().max(8000).default(""),
  invite_note: z.string().max(300).optional().nullable(),
  attachment_id: z.string().uuid().optional().nullable(),
  prospect_ids: z.array(z.string().uuid()).max(1000).default([]),
  category: z.enum(LI_CATEGORIES),
});

export const GET = withErrorHandler(async () => {
  await requireRole([...LINKEDIN_ROLES]);
  return successResponse(await listCampaigns());
});

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireRole([...LINKEDIN_ROLES]);
  const b = Body.parse(await req.json());
  const c = await createCampaign({
    name: b.name,
    accountId: b.account_id,
    template: b.template,
    inviteNote: b.invite_note ?? null,
    attachmentId: b.attachment_id ?? null,
    category: b.category,
    prospectIds: b.prospect_ids,
    actorId: user.id,
  });
  return successResponse(c, 201);
});
