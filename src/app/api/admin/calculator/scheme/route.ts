import { z } from "zod";
import { withErrorHandler, successResponse } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { saveScheme, deactivateScheme } from "@/lib/calculator/admin-service";

export const dynamic = "force-dynamic";

const saveSchema = z.object({
  nbfcId: z.number().int().positive(),
  schemeId: z.number().int().positive().optional(),
  tenure: z.number().int().positive(),
  advance: z.number().int().nonnegative(),
  appliedInterestRate: z.string(),
  processingFeePaise: z.number().int().nonnegative(),
  advanceInterestRate: z.string(),
  status: z.enum(["active", "disabled"]).optional(),
});

// Save (create/edit) a scheme, or deactivate one: { action: "deactivate", schemeId }.
export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireRole(["admin", "sales_head"]);
  const body = await req.json();
  if (body?.action === "deactivate") {
    const schemeId = z.number().int().positive().parse(body.schemeId);
    return successResponse(await deactivateScheme(String(user.id), schemeId));
  }
  const input = saveSchema.parse(body);
  return successResponse(await saveScheme(String(user.id), input));
});
