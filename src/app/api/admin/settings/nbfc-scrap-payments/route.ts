/**
 * E-259 — GET / PUT the per-NBFC scrap payment terms.
 *
 * Its own route beside `/api/admin/settings/nbfc-request-sla` for the same
 * reason that one sits apart from the settings bundle: it is not a singleton
 * config object but a row per NBFC, and PUT addresses one of them.
 *
 * ROLES. Read and write are both `admin` + `sales_head`, matching the two
 * neighbouring settings screens. Note this is NOT the same bar as releasing a
 * payment (admin/ceo, see the scrap consignment route): choosing the terms a
 * counterparty trades on is a commercial policy decision, and executing a
 * transfer under them is a treasury one.
 */
import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import {
  DEFAULT_TIMING,
  SCRAP_PAYMENT_TIMINGS,
  listScrapPaymentTerms,
  setScrapPaymentTiming,
} from "@/lib/nbfc/scrap/payment-settings";

export const dynamic = "force-dynamic";

const EDITOR_ROLES = ["admin", "sales_head"];

const BodySchema = z.object({
  tenantId: z.string().uuid(),
  timing: z.enum(SCRAP_PAYMENT_TIMINGS),
  note: z.string().max(2000).nullable().optional(),
});

export const GET = withErrorHandler(async () => {
  await requireRole(EDITOR_ROLES);
  const terms = await listScrapPaymentTerms();
  return successResponse({ terms, defaultTiming: DEFAULT_TIMING });
});

export const PUT = withErrorHandler(async (req: Request) => {
  const user = await requireRole(EDITOR_ROLES);
  const body = BodySchema.parse(await req.json());
  const term = await setScrapPaymentTiming({
    tenant_id: body.tenantId,
    timing: body.timing,
    note: body.note ?? null,
    // The settings row records who last changed the term; `requireRole`
    // returns the session user, whose id is the uuid the column expects.
    actor_user_id: user?.id ?? null,
  });
  return successResponse({ term });
});
