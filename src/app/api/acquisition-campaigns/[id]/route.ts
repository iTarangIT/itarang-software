// PATCH /api/acquisition-campaigns/:id — rename, re-date, or close a campaign.
// Closing keeps the campaign on every lead that has it; it only leaves the
// pickers. There is no delete: a campaign on a lead is part of that lead's
// locked source.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { LEAD_ORIGINS } from "@/lib/leads/leadSourceVocab";
import { updateCampaign } from "@/lib/leads/acquisitionCampaigns";
import { CAMPAIGN_MANAGE_ROLES } from "@/lib/leads/campaignAccess";

export const dynamic = "force-dynamic";

const date = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-01")
    .nullable()
    .optional();

const PatchSchema = z.object({
    name: z.string().trim().min(2, "Give the campaign a name.").max(160).optional(),
    origin: z.enum(LEAD_ORIGINS).nullable().optional(),
    starts_on: date,
    ends_on: date,
    notes: z.string().trim().max(1000).nullable().optional(),
    is_active: z.boolean().optional(),
});

export const PATCH = withErrorHandler(
    async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
        await requireRole([...CAMPAIGN_MANAGE_ROLES]);
        const { id } = await params;
        const b = PatchSchema.parse(await req.json());
        await updateCampaign(id, {
            name: b.name,
            origin: b.origin,
            startsOn: b.starts_on,
            endsOn: b.ends_on,
            notes: b.notes,
            isActive: b.is_active,
        });
        return successResponse({ id });
    },
);
