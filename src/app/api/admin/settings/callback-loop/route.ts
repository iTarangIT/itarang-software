/**
 * D8 — GET / PUT the AI-call callback loop settings.
 *
 *   owner_ids     the ISRs who take callbacks on UNOWNED leads, in turn
 *                 (round-robin). A lead with an owner keeps its owner.
 *   neodove_push  15 min before a callback, push the lead into the ISR's own
 *                 NeoDove campaign. Off until the one-off NeoDove test passes.
 *
 * Stored in app_settings['callback_loop'] (src/lib/ai-dialer/callbackLoop.ts).
 */

import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { getCallbackLoopSettings, setCallbackLoopSettings } from "@/lib/ai-dialer/callbackLoop";
import { callbackOnTimeByOwner } from "@/lib/ai-dialer/callbackMetrics";

/** IST calendar day `daysAgo` before today, YYYY-MM-DD. */
function istDayAgo(daysAgo: number): string {
    return new Date(Date.now() + 330 * 60_000 - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

export const dynamic = "force-dynamic";

const ROLES = ["admin", "ceo", "sales_head"];

const BodySchema = z.object({
    ownerIds: z.array(z.string().trim().min(1)).max(50),
    neodovePush: z.boolean(),
});

export const GET = withErrorHandler(async () => {
    await requireRole(ROLES);
    // Task 11 — the ISR metric: promised callbacks made within 30 minutes.
    const [settings, onTime] = await Promise.all([
        getCallbackLoopSettings(),
        callbackOnTimeByOwner({ fromIstDay: istDayAgo(6), toIstDay: istDayAgo(0) }),
    ]);
    return successResponse({ settings, onTime });
});

export const PUT = withErrorHandler(async (req: Request) => {
    const user = await requireRole(ROLES);
    const body = BodySchema.parse(await req.json());
    const settings = await setCallbackLoopSettings({ ...body, updatedBy: user.id });
    return successResponse({ settings });
});
