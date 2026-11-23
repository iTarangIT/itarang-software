// LinkedIn Outreach — mark do-not-contact, link a CRM lead.
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { updateProspect } from "@/lib/linkedin/services/prospects";

export const dynamic = "force-dynamic";

const Body = z.object({
  do_not_contact: z.boolean().optional(),
  do_not_contact_reason: z.string().trim().max(300).optional().nullable(),
  lead_id: z.string().trim().max(50).optional().nullable(),
});

export const PATCH = withErrorHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  await requireRole([...LINKEDIN_ROLES]);
  return successResponse(await updateProspect(id, Body.parse(await req.json())));
});
