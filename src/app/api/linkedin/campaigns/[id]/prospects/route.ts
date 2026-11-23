// LinkedIn Outreach — add / remove prospects on a draft campaign.
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { addProspects, removeProspects } from "@/lib/linkedin/services/campaigns";

export const dynamic = "force-dynamic";

const Body = z.object({
  add: z.array(z.string().uuid()).max(1000).default([]),
  remove: z.array(z.string().uuid()).max(1000).default([]),
});

export const POST = withErrorHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  await requireRole([...LINKEDIN_ROLES]);
  const b = Body.parse(await req.json());
  if (b.add.length) await addProspects(id, b.add);
  if (b.remove.length) await removeProspects(id, b.remove);
  return successResponse({ added: b.add.length, removed: b.remove.length });
});
