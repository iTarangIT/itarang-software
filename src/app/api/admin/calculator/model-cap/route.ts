import { z } from "zod";
import { withErrorHandler, successResponse } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { saveModelCap } from "@/lib/calculator/admin-service";

export const dynamic = "force-dynamic";

const schema = z.object({
  nbfcId: z.number().int().positive(),
  modelId: z.number().int().positive(),
  maxLoanCapPaise: z.number().int().nonnegative(),
});

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireRole(["admin", "sales_head"]);
  const input = schema.parse(await req.json());
  return successResponse(await saveModelCap(String(user.id), input));
});
