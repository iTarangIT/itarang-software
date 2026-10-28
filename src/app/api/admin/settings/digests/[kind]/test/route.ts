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
import { NOT_ON_LIST, runDigest } from "@/lib/digests/engine";
import { DIGEST_KIND_IDS, DIGEST_KINDS, digestKind } from "@/lib/digests/registry";
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
        // ID 194 — a personal kind (My day): whose mail to build.
        personId: z.string().min(1).max(64).optional(),
    })
    .optional();

export const POST = withErrorHandler(
    async (req: Request, ctx: { params: Promise<{ kind: string }> }) => {
        const user = await requireRole(EDITOR_ROLES);

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
            // A personal kind's test goes to whoever pressed the button, never
            // to the person it was written for.
            toOverride: body.to ?? (kind.perRecipient && user.email ? [user.email] : undefined),
            istDayOverride: body.istDay,
            personId: body.personId,
        });

        const outcome = result.outcomes[0];

        // ID 198 — a test "as" a manager also sends the kinds that ride on this
        // one's settings (My team with My day). Someone with nobody reporting
        // to them is not on that list: they get the one mail, quietly.
        const also: Array<{ kind: string; label: string; sent: boolean; error: string | null }> = [];
        if (body.personId) {
            for (const sibling of DIGEST_KINDS.filter((k) => k.settingsOf === kind.id)) {
                const r = await runDigest({
                    kind: sibling,
                    slot: "test",
                    triggeredBy: "manual",
                    toOverride: body.to ?? (user.email ? [user.email] : undefined),
                    istDayOverride: body.istDay,
                    personId: body.personId,
                });
                const o = r.outcomes[0];
                if (o?.error === NOT_ON_LIST) continue;
                also.push({ kind: sibling.id, label: sibling.label, sent: o?.sent ?? false, error: o?.error ?? null });
            }
        }

        return successResponse({
            ok: result.ok,
            sent: outcome?.sent ?? false,
            recipients: outcome?.recipients ?? [],
            digestDate: outcome?.digestDate ?? null,
            error: outcome?.error ?? null,
            also,
        });
    },
);
