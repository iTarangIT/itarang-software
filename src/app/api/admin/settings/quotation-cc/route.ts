/**
 * E-297 — GET / PUT the fixed Quotation CC list.
 *
 * Every approved quotation emailed to a dealer is CC'd to these addresses, on
 * top of the lead's current owner and the sender (B4 — was the approver; see
 * src/lib/leads/quotationCc.ts). Stored under `quotation_cc_emails` in
 * app_settings, so no table of its own.
 *
 * admin, ceo and sales_head may all change who is copied on every quotation
 * (sales_head was view-only until 2026-09-18 — the list is the sales team's
 * own distribution list, so the sales head owns it).
 */

import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import {
  MAX_FIXED_CC,
  getQuotationCcSettings,
  setQuotationCcSettings,
} from "@/lib/leads/quotationCc";

export const dynamic = "force-dynamic";

const VIEWER_ROLES = ["admin", "ceo", "sales_head"];
const EDITOR_ROLES = ["admin", "ceo", "sales_head"];

const BodySchema = z.object({
  emails: z
    .array(z.string().trim().email("Each CC entry must be a valid email.").max(320))
    .max(MAX_FIXED_CC, `At most ${MAX_FIXED_CC} addresses.`),
});

export const GET = withErrorHandler(async () => {
  const user = await requireRole(VIEWER_ROLES);
  const settings = await getQuotationCcSettings();
  return successResponse({
    settings,
    max: MAX_FIXED_CC,
    can_edit: EDITOR_ROLES.includes(user.role),
  });
});

export const PUT = withErrorHandler(async (req: Request) => {
  const user = await requireRole(EDITOR_ROLES);
  const { emails } = BodySchema.parse(await req.json());
  const settings = await setQuotationCcSettings(emails, user.id);
  return successResponse({ settings, max: MAX_FIXED_CC, can_edit: true });
});
