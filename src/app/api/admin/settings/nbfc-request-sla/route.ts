/**
 * GET / PUT the NBFC request SLA settings (E-254).
 *
 * Kept out of the `/api/admin/settings` bundle for the same reason
 * `/api/admin/settings/kyc-automation` is: it is a singleton unrelated to the
 * assignment / holiday / territory triple.
 */

import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import {
    getNbfcRequestSlaSettings,
    setNbfcRequestSlaSettings,
    MAX_SLA_MINUTES,
    MIN_SLA_MINUTES,
} from "@/lib/nbfc/request-sla-settings";

export const dynamic = "force-dynamic";

const EDITOR_ROLES = ["admin", "sales_head"];

// Every field optional so the form can PATCH a single toggle; the store merges
// over the current value. Windows are bounded here as well as clamped in the
// store — a 400 tells the admin their input was rejected, where a silent clamp
// would leave the form showing a number the server did not keep.
const Minutes = z.number().int().min(MIN_SLA_MINUTES).max(MAX_SLA_MINUTES).optional();

const BodySchema = z.object({
    enabled: z.boolean().optional(),
    forwardSlaMinutes: Minutes,
    pushSlaMinutes: Minutes,
    autoForwardToDealer: z.boolean().optional(),
    autoPushToNbfc: z.boolean().optional(),
});

export const GET = withErrorHandler(async () => {
    await requireRole(EDITOR_ROLES);
    const settings = await getNbfcRequestSlaSettings();
    return successResponse({ settings });
});

export const PUT = withErrorHandler(async (req: Request) => {
    await requireRole(EDITOR_ROLES);
    const patch = BodySchema.parse(await req.json());
    const settings = await setNbfcRequestSlaSettings(patch);
    return successResponse({ settings });
});
