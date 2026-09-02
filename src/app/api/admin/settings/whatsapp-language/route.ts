/**
 * GET / PUT the WhatsApp bot output language.
 *
 * Own route (not the `/api/admin/settings` bundle) for the same reason
 * kyc-automation is: a singleton that nothing else in the bundle cares about.
 */

import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import {
  getWhatsAppLanguageSettings,
  setWhatsAppLanguageSettings,
  WHATSAPP_LANGUAGES,
} from "@/lib/whatsapp/language-settings";

export const dynamic = "force-dynamic";

const EDITOR_ROLES = ["admin", "sales_head"];

const BodySchema = z.object({
  language: z.enum(WHATSAPP_LANGUAGES),
});

export const GET = withErrorHandler(async () => {
  await requireRole(EDITOR_ROLES);
  const settings = await getWhatsAppLanguageSettings();
  return successResponse({ settings, languages: WHATSAPP_LANGUAGES });
});

export const PUT = withErrorHandler(async (req: Request) => {
  await requireRole(EDITOR_ROLES);
  const patch = BodySchema.parse(await req.json());
  const settings = await setWhatsAppLanguageSettings(patch);
  return successResponse({ settings, languages: WHATSAPP_LANGUAGES });
});
