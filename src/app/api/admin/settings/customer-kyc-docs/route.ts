// E-392 — Battery Pool diagram 1, part 3. Settings › Customer KYC documents.
//
//   GET → the catalogue (mandatory / configurable / web-only) + which are asked.
//   PUT { enabled: string[] } → save the asked configurable documents.
//
// Aadhaar front/back and PAN are always asked and can't be turned off.
// Admin and Sales Head.

import { z } from "zod";

import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { CUSTOMER_DOC_CATALOGUE, getCustomerDocConfig, setCustomerDocConfig } from "@/lib/kyc/customer-doc-config";

export const dynamic = "force-dynamic";

const EDITOR_ROLES = ["admin", "sales_head"];

export const GET = withErrorHandler(async () => {
  await requireRole(EDITOR_ROLES);
  const config = await getCustomerDocConfig();
  return successResponse({
    catalogue: CUSTOMER_DOC_CATALOGUE.map((d) => ({
      key: d.key,
      label: d.label,
      mandatory: d.mandatory,
      whatsapp: !!d.wa,
      asked: d.mandatory || config.enabled.includes(d.key),
    })),
    config,
  });
});

const Body = z.object({ enabled: z.array(z.string().max(50)).max(20) });

export const PUT = withErrorHandler(async (req: Request) => {
  await requireRole(EDITOR_ROLES);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse("Invalid document list", 400);
  return successResponse({ config: await setCustomerDocConfig(parsed.data) });
});
