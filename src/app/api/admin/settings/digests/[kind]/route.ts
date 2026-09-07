/**
 * GET / PUT one digest's settings (E-287, generalised by E-288).
 *
 * Kept out of the `/api/admin/settings` bundle for the same reason
 * `/api/admin/settings/kyc-automation` is: that bundle is the BRD §0.11/§0.12
 * assignment / holiday / territory triple, and folding an unrelated singleton
 * into it would make every consumer of the bundle re-fetch on a change here.
 *
 * One route serves every registered kind — `[kind]` is a descriptor id.
 */

import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { recentDigestRuns } from "@/lib/digests/engine";
import { DIGEST_KIND_IDS, digestKind } from "@/lib/digests/registry";
import { MAX_RECIPIENTS } from "@/lib/digests/schedule";
import { getDigestSettings, setDigestSettings } from "@/lib/digests/settings";

export const dynamic = "force-dynamic";

const EDITOR_ROLES = ["admin", "sales_head"];

// Every field optional so the form can PATCH a single toggle; the store merges
// over the current value. Hours and minutes are bounded here as well as clamped
// in the store — a 400 tells the admin their input was rejected, where a silent
// clamp would leave the form showing a number the server did not keep.
//
// `recipients` has a MINIMUM of one, and `sections` is refined to reject an
// all-off patch. Neither is a shorter mail: a digest with no recipients or no
// blocks still claims its slot and still reads as a successful send on the
// ledger. Switching it off is how "send nothing" is spelled.
const BodySchema = z.object({
    enabled: z.boolean().optional(),
    recipients: z.array(z.string().email()).min(1).max(MAX_RECIPIENTS).optional(),
    morningHour: z.number().int().min(0).max(23).optional(),
    morningMinute: z.number().int().min(0).max(59).optional(),
    eveningHour: z.number().int().min(0).max(23).optional(),
    eveningMinute: z.number().int().min(0).max(59).optional(),
    detail: z.enum(["summary", "detailed"]).optional(),
    sections: z
        .record(z.string(), z.boolean())
        .refine((s) => Object.keys(s).length === 0 || Object.values(s).some(Boolean), {
            message:
                "Keep at least one section, or switch the digest off — a mail with nothing in it still sends.",
        })
        .optional(),
    attachExcel: z.boolean().optional(),
});

function resolve(kindId: string) {
    const kind = digestKind(kindId);
    if (!kind) {
        throw Object.assign(
            new Error(`unknown digest "${kindId}" (known: ${DIGEST_KIND_IDS.join(", ")})`),
            { status: 404 },
        );
    }
    return kind;
}

export const GET = withErrorHandler(
    async (_req: Request, ctx: { params: Promise<{ kind: string }> }) => {
        await requireRole(EDITOR_ROLES);
        const kind = resolve((await ctx.params).kind);

        const [settings, runs] = await Promise.all([
            getDigestSettings(kind),
            // Empty on a database without E-288 applied — the screen still lets an
            // admin configure the digest, it just cannot show a history yet.
            recentDigestRuns(kind.id, 8),
        ]);

        return successResponse({
            settings,
            runs,
            // The screen renders its tick-boxes and headings from this, so a
            // descriptor gaining a section needs no front-end change.
            kind: {
                id: kind.id,
                label: kind.label,
                description: kind.description,
                ctaHref: kind.ctaHref,
                ctaLabel: kind.ctaLabel,
                sections: kind.sections,
            },
        });
    },
);

export const PUT = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ kind: string }> }) => {
        await requireRole(EDITOR_ROLES);
        const kind = resolve((await ctx.params).kind);
        const patch = BodySchema.parse(await req.json());
        const settings = await setDigestSettings(kind, patch);
        return successResponse({ settings });
    },
);
