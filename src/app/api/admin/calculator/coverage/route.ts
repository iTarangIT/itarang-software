import { z } from "zod";
import { withErrorHandler, successResponse } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { addCoverageCity, removeCoverageCity } from "@/lib/calculator/admin-service";

export const dynamic = "force-dynamic";

const addSchema = z.object({
  nbfcId: z.number().int().positive(),
  cityDisplay: z.string().min(1),
  stateCode: z.string().min(1).max(3),
});

// Add a city ({ nbfcId, cityDisplay, stateCode }) or remove one ({ action:"remove", coverageId }).
export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireRole(["admin", "sales_head"]);
  const body = await req.json();
  if (body?.action === "remove") {
    const coverageId = z.number().int().positive().parse(body.coverageId);
    return successResponse(await removeCoverageCity(String(user.id), coverageId));
  }
  const input = addSchema.parse(body);
  return successResponse(await addCoverageCity(String(user.id), input));
});
