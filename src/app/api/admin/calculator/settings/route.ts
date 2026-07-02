import { z } from "zod";
import { withErrorHandler, successResponse } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { getSettings, saveSettings } from "@/lib/calculator/admin-service";

export const dynamic = "force-dynamic";

const schema = z.object({
  dealerMarginPaise: z.number().int().nonnegative().optional(),
  nearBestWindowPct: z.string().optional(),
  expectedEmiFilterRequired: z.boolean().optional(),
  upfrontFilterRequired: z.boolean().optional(),
  disclaimerText: z.string().optional(),
  cardFooterDisclaimer: z.string().optional(),
  contactPhone: z.string().optional(),
  contactEmail: z.string().optional(),
  contactWhatsapp: z.string().optional(),
});

export const GET = withErrorHandler(async () => {
  await requireRole(["admin", "sales_head"]);
  return successResponse(await getSettings());
});

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireRole(["admin", "sales_head"]);
  const patch = schema.parse(await req.json());
  return successResponse(await saveSettings(String(user.id), patch));
});
