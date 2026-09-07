/**
 * "Send test now" for one digest (E-287, generalised by E-288).
 *
 * Mails the real template with the real numbers, immediately, ignoring both the
 * schedule and the master switch — testing the template and the mailbox is
 * exactly what somebody does BEFORE turning a digest on, so a test that required
 * it to be on would be useless.
 *
 * It writes a `slot='test'` row to the ledger for the audit trail, which the
 * partial unique index deliberately does not cover: an admin testing at 09:30
 * must not suppress that morning's actual digest.
 */

import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { runDigest } from "@/lib/digests/engine";
import { DIGEST_KIND_IDS, digestKind } from "@/lib/digests/registry";
import { MAX_RECIPIENTS } from "@/lib/digests/schedule";

export const dynamic = "force-dynamic";

const EDITOR_ROLES = ["admin", "sales_head"];

const BodySchema = z
    .object({
        // Send the test somewhere other than the configured list — so an admin can
        // check the template against their own inbox without first pointing the
        // live digest at it.
        to: z.array(z.string().email()).min(1).max(MAX_RECIPIENTS).optional(),
        // Count a specific IST day instead of today. Useful for eyeballing the
        // template against a day that actually had activity.
        istDay: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, "istDay must be YYYY-MM-DD")
            .optional(),
    })
    .optional();

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ kind: string }> }) => {
        await requireRole(EDITOR_ROLES);

        const kindId = (await ctx.params).kind;
        const kind = digestKind(kindId);
        if (!kind) {
            throw Object.assign(
                new Error(`unknown digest "${kindId}" (known: ${DIGEST_KIND_IDS.join(", ")})`),
                { status: 404 },
            );
        }

        // The form posts an empty body; tolerate that rather than 400ing on it.
        const raw = await req.json().catch(() => ({}));
        const body = BodySchema.parse(raw) ?? {};

        const result = await runDigest({
            kind,
            slot: "test",
            triggeredBy: "manual",
            toOverride: body.to,
            istDayOverride: body.istDay,
        });

        const outcome = result.outcomes[0];

        return successResponse({
            ok: result.ok,
            sent: outcome?.sent ?? false,
            recipients: outcome?.recipients ?? [],
            digestDate: outcome?.digestDate ?? null,
            error: outcome?.error ?? null,
        });
    },
);
