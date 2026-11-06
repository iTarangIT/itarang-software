/**
 * Priya KPI tasks 5 + 10 — GET / PUT Settings › Dialer alerts.
 *
 *   userIds        CRM users told about a carrier pause and sent the nightly readout
 *   emails         extra addresses with no login (it@itarang.com)
 *   probeNumber    the number the carrier probe rings (10-digit mobile)
 *   agentVersion   label printed on the readout ("v27")
 *   changeTested   "change tested" line printed on the readout
 *
 * Stored in app_settings['dialer_alerts'] (src/lib/ai-dialer/dialerAlerts.ts).
 */

import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { getDialerAlertSettings, setDialerAlertSettings } from "@/lib/ai-dialer/dialerAlerts";

export const dynamic = "force-dynamic";

const ROLES = ["admin", "ceo"];

const BodySchema = z.object({
    userIds: z.array(z.string().trim().min(1)).max(50),
    emails: z.array(z.string().trim().email()).max(20),
    probeNumber: z.string().trim().min(10).max(16),
    agentVersion: z.string().max(40).default(""),
    changeTested: z.string().max(200).default(""),
});

export const GET = withErrorHandler(async () => {
    await requireRole(ROLES);
    return successResponse({ settings: await getDialerAlertSettings() });
});

export const PUT = withErrorHandler(async (req: Request) => {
    const user = await requireRole(ROLES);
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? "Invalid settings", 400);
    try {
        const settings = await setDialerAlertSettings({ ...parsed.data, updatedBy: user.id });
        return successResponse({ settings });
    } catch (err) {
        return errorResponse(err instanceof Error ? err.message : "Save failed", 400);
    }
});
