// /api/acquisition-campaigns — the acquisition campaign register (tracker ID 81).
//
// GET   everyone who can create or read a lead. `?picker=1` narrows to what a
//       form offers: open campaigns a person named, for `?origin=` when given.
// POST  a new campaign. Managers only: the list is what reps pick from, and a
//       register anyone can add to fills with near-duplicates ("Auto Expo",
//       "AutoExpo 26") that split one event's leads.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { LEADS_PAGE_ROLES } from "@/lib/leads/access";
import { LEAD_ORIGINS } from "@/lib/leads/leadSourceVocab";
import { createCampaign, listCampaigns } from "@/lib/leads/acquisitionCampaigns";
import { CAMPAIGN_MANAGE_ROLES, canManageCampaigns } from "@/lib/leads/campaignAccess";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole([...LEADS_PAGE_ROLES]);
    const params = new URL(req.url).searchParams;
    const picker = params.get("picker") === "1";
    const origin = params.get("origin");
    const campaigns = await listCampaigns({
        origin: origin && (LEAD_ORIGINS as readonly string[]).includes(origin) ? origin : null,
        activeOnly: picker,
        manualOnly: picker,
    });
    return successResponse({ campaigns, can_manage: canManageCampaigns(user.role) });
});

const date = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-01")
    .optional()
    .nullable();

const CreateSchema = z.object({
    name: z.string().trim().min(2, "Give the campaign a name.").max(160),
    origin: z.enum(LEAD_ORIGINS).optional().nullable(),
    starts_on: date,
    ends_on: date,
    notes: z.string().trim().max(1000).optional().nullable(),
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole([...CAMPAIGN_MANAGE_ROLES]);
    const b = CreateSchema.parse(await req.json());
    const created = await createCampaign({
        name: b.name,
        origin: b.origin ?? null,
        startsOn: b.starts_on ?? null,
        endsOn: b.ends_on ?? null,
        notes: b.notes ?? null,
        createdBy: user.id,
    });
    return successResponse(created, 201);
});
