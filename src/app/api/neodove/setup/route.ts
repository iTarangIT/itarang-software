// GET /api/neodove/setup — what the NeoDove screens need to tell Sales Head
// whether the one-time server setup is done (26 Oct). Booleans only: the
// webhook secret and the encryption key never leave the server.
//
// Per-campaign URLs are pasted on screen (E-351). These three are set once per
// server, not per campaign, which is why they stay environment config.

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { getNeodoveConfig } from "@/lib/neodove/config";
import { endpointStoreStatus } from "@/lib/neodove/endpointStore";
import { NEODOVE_ADMIN_ROLES, NEODOVE_MANAGE_ROLES } from "@/lib/neodove/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
    const user = await requireRole(NEODOVE_ADMIN_ROLES);
    const cfg = getNeodoveConfig();
    return successResponse({
        enabled: cfg.enabled,
        webhookSecretSet: Boolean(cfg.webhookSecret),
        endpointStore: await endpointStoreStatus(),
        canManage: NEODOVE_MANAGE_ROLES.includes(user.role),
    });
});
