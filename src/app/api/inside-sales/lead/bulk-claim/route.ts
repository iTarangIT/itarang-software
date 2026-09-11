// POST /api/inside-sales/lead/bulk-claim
// IS rep claims several leads from the Unassigned queue in one action.
// Body: { lead_ids: string[] } (≤ BULK_CLAIM_CAP).
//
// Each lead is claimed independently through claimLead — a lead another rep
// won in the meantime is skipped and counted, the rest still go through. A
// partial batch is better than none; the caller is told exactly what happened.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { BULK_CLAIM_CAP, CLAIM_ROLES, claimLead } from "@/lib/inside-sales/claimLead";
import type { BulkClaimResult } from "@/lib/inside-sales/types";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
    lead_ids: z.array(z.string().min(1)).min(1).max(BULK_CLAIM_CAP),
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole([...CLAIM_ROLES]);
    const body = BodySchema.parse(await req.json());
    const ids = Array.from(new Set(body.lead_ids));

    const result: BulkClaimResult = {
        ok: true,
        claimed: 0,
        skipped_already_owned: 0,
        skipped_terminal: 0,
        skipped_not_found: 0,
    };

    for (const id of ids) {
        const outcome = await claimLead(id, user.id);
        if (outcome.ok) {
            result.claimed++;
            continue;
        }
        switch (outcome.reason) {
            case "already_owned":
                result.skipped_already_owned++;
                break;
            case "terminal":
                result.skipped_terminal++;
                break;
            case "not_found":
                result.skipped_not_found++;
                break;
        }
    }

    return successResponse(result);
});
