import { withErrorHandler, successResponse } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { resolveConfigMeta } from "@/lib/calculator/config-resolver";

export const dynamic = "force-dynamic";

// Dropdown data for Card 1: active battery models, available tenures, coverage cities.
export const GET = withErrorHandler(async () => {
  await requireRole(["dealer"]);
  const meta = await resolveConfigMeta();
  return successResponse(meta);
});
