/**
 * GET / PUT the KYC auto-approval settings (E-242).
 *
 * Kept out of the `/api/admin/settings` bundle for the same reason
 * `/api/admin/notification-access` is: the bundle is the BRD §0.11/§0.12
 * assignment / holiday / territory triple, and folding an unrelated singleton
 * into it would make every consumer of the bundle re-fetch on a change here.
 */

import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import {
    getKycAutoApprovalSettings,
    setKycAutoApprovalSettings,
    MAX_SLA_MINUTES,
    MIN_SLA_MINUTES,
} from "@/lib/kyc/auto-approval-settings";

export const dynamic = "force-dynamic";

const EDITOR_ROLES = ["admin", "sales_head"];

// Every field optional so the form can PATCH a single toggle; the store merges
// over the current value. slaMinutes is bounded here as well as clamped in the
// store — a 400 tells the admin their input was rejected, where a silent clamp
// would leave the form showing a number the server did not keep.
// Per-card window (E-244). `null` is meaningful and must survive validation —
// it is how the form clears one card back to the global window; the store drops
// it rather than storing a null. Bounds match the global window exactly, so a
// card cannot be given a window the case itself could not have.
const CardMinutes = z
    .number()
    .int()
    .min(MIN_SLA_MINUTES)
    .max(MAX_SLA_MINUTES)
    .nullable()
    .optional();

const BodySchema = z.object({
    enabled: z.boolean().optional(),
    slaMinutes: z.number().int().min(MIN_SLA_MINUTES).max(MAX_SLA_MINUTES).optional(),
    cardSlaMinutes: z
        .object({
            aadhaar: CardMinutes,
            pan: CardMinutes,
            bank: CardMinutes,
            cibil: CardMinutes,
            rc: CardMinutes,
        })
        .optional(),
    autoVerifyConsent: z.boolean().optional(),
    autoApproveCards: z.boolean().optional(),
    autoVerifyRequiredDocs: z.boolean().optional(),
    autoFinalApprove: z.boolean().optional(),
});

export const GET = withErrorHandler(async () => {
    await requireRole(EDITOR_ROLES);
    const settings = await getKycAutoApprovalSettings();
    return successResponse({ settings });
});

export const PUT = withErrorHandler(async (req: Request) => {
    await requireRole(EDITOR_ROLES);
    const patch = BodySchema.parse(await req.json());
    const settings = await setKycAutoApprovalSettings(patch);
    return successResponse({ settings });
});
