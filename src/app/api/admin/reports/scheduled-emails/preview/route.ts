// Reports › Scheduled email reports — Preview (tracker ID 13).
//
// POST { kind }  the email as it would go out now, with today's real numbers:
// subject and HTML. Nothing is sent and nothing is recorded — the figures are
// collected with the kind's own read-only queries and rendered with the same
// template the scheduled send uses.

import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { digestKind } from "@/lib/digests/registry";
import { digestDateForSlot } from "@/lib/digests/schedule";
import { getDigestSettings } from "@/lib/digests/settings";
import { buildDigestEmail } from "@/lib/email/sendDigestEmail";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const VIEW_ROLES = ["admin", "sales_head", "ceo"];
const Body = z.object({ kind: z.string().min(1) });

export const POST = withErrorHandler(async (req: Request) => {
    await requireRole(VIEW_ROLES);
    const kind = digestKind(Body.parse(await req.json()).kind);
    if (!kind) throw Object.assign(new Error("Unknown report."), { status: 404 });

    const settings = await getDigestSettings(kind);
    const slot = (kind.slots ?? ["morning", "evening"])[0];
    const istDay = digestDateForSlot(slot);
    const collected = await kind.collect(istDay);
    if (!collected.ok) throw Object.assign(new Error(collected.error ?? "The report's figures could not be collected."), { status: 500 });
    const detail = settings.detail === "detailed" ? await kind.collectDetail(istDay) : null;

    const { subject, html } = buildDigestEmail({
        kind,
        to: [],
        slot,
        istDay,
        figures: collected.figures,
        detail: settings.detail,
        detailRows: detail?.ok ? detail.detail : undefined,
        sections: settings.sections,
        attachment: null,
    });
    return successResponse({ subject, html, for_day: istDay, recipients: settings.recipients });
});
