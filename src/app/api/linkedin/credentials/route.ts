// LinkedIn Outreach — provider keys, stored encrypted in THIS environment's
// database. GET shows only where each key comes from and its last 4
// characters; the value never leaves the server.
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import {
  CREDENTIAL_SLOTS,
  credentialStatus,
  deleteSecret,
  saveSecret,
  type CredentialSlot,
} from "@/lib/linkedin/credentials";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";

export const dynamic = "force-dynamic";

const slots = Object.keys(CREDENTIAL_SLOTS).filter((s) => s !== "webhook:secret") as [CredentialSlot, ...CredentialSlot[]];
const Put = z.object({ slot: z.enum(slots), value: z.string().trim().min(1).max(2000) });

export const GET = withErrorHandler(async () => {
  await requireRole([...LINKEDIN_ROLES]);
  return successResponse(await credentialStatus());
});

export const PUT = withErrorHandler(async (req: Request) => {
  const user = await requireRole([...LINKEDIN_ROLES]);
  const { slot, value } = Put.parse(await req.json());
  return successResponse(await saveSecret(slot, value, user.id));
});

export const DELETE = withErrorHandler(async (req: Request) => {
  await requireRole([...LINKEDIN_ROLES]);
  const slot = z.enum(slots).parse(new URL(req.url).searchParams.get("slot"));
  await deleteSecret(slot);
  return successResponse({ deleted: slot });
});
