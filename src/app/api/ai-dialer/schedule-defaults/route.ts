// GET /api/ai-dialer/schedule-defaults
//
// E-254 — the calling window the campaign form pre-fills with, read from
// assignment_config (E-120).
//
// Its own route rather than reusing GET /api/admin/settings, which serves the
// same table: that route is admin-gated, while the dialer modal is used by
// sales_head / sales_manager / ASM. Pointing the modal at it would 403 for
// exactly the people who start campaigns.
//
// Only the three window fields are returned — nothing else in assignment_config
// is any of the dialer's business.

import { resolveScheduleDefaults } from "@/lib/queue/campaignWindow";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireAuth } from "@/lib/auth-utils";

export const GET = withErrorHandler(async () => {
  await requireAuth();
  return successResponse(await resolveScheduleDefaults());
});
