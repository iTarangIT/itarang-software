import { z } from "zod";
import { withErrorHandler, successResponse } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { saveComponentPrice } from "@/lib/calculator/admin-service";

export const dynamic = "force-dynamic";

const schema = z.object({
  modelId: z.number().int().positive(),
  component: z.enum(["battery", "charger", "harness", "soc", "iot"]),
  amountPaise: z.number().int().nonnegative().optional(),
  gstMultiplier: z.string().optional(),
});

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireRole(["admin", "sales_head"]);
  const input = schema.parse(await req.json());
  return successResponse(await saveComponentPrice(String(user.id), input));
});
