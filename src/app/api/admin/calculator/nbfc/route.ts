import { z } from "zod";
import { withErrorHandler, successResponse } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { getNbfcDetail, saveNbfc } from "@/lib/calculator/admin-service";

export const dynamic = "force-dynamic";

const schema = z.object({
  nbfcId: z.number().int().positive(),
  name: z.string().optional(),
  maxLoanCapPaise: z.number().int().nonnegative().nullable().optional(),
  flatInterestRate: z.string().nullable().optional(),
  fileFeePaise: z.number().int().nonnegative().optional(),
  defaultProcessingFeePaise: z.number().int().nonnegative().optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

export const GET = withErrorHandler(async (req: Request) => {
  await requireRole(["admin", "sales_head"]);
  const id = Number(new URL(req.url).searchParams.get("nbfcId"));
  if (!id) return successResponse(null);
  return successResponse(await getNbfcDetail(id));
});

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireRole(["admin", "sales_head"]);
  const { nbfcId, ...patch } = schema.parse(await req.json());
  return successResponse(await saveNbfc(String(user.id), nbfcId, patch));
});
