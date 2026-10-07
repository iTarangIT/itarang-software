// Reports › Scheduled email reports (tracker ID 13).
//
// GET   every scheduled email: what it holds, when it goes, who gets it and
//       when it was last sent. Read-only — turning a report on or off and
//       changing its recipients stays under Settings.
// POST  { kind } "Send me a copy": mails the real report, with today's real
//       numbers, to the person asking and nobody else. Recorded as a test send,
//       so it never suppresses the scheduled one.

import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { lastDigestSend, runDigest } from "@/lib/digests/engine";
import { DIGEST_KINDS, digestKind } from "@/lib/digests/registry";
import { getDigestSettings } from "@/lib/digests/settings";

export const dynamic = "force-dynamic";

const VIEW_ROLES = ["admin", "sales_head", "ceo"];
// Who may change a digest's settings — the settings routes' own list.
const SETTINGS_ROLES = ["admin", "sales_head"];

const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} IST`;
const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/** "Every day", or the IST weekdays the kind sends on ("Mondays"). */
function whichDays(weekdays: number[] | undefined): string {
    if (!weekdays || weekdays.length === 0 || weekdays.length === 7) return "Every day";
    return weekdays
        .slice()
        .sort((a, b) => a - b)
        .map((d) => DAY_NAMES[d] ?? `day ${d}`)
        .join(", ");
}

export const GET = withErrorHandler(async () => {
    const user = await requireRole(VIEW_ROLES);
    const reports = await Promise.all(
        DIGEST_KINDS.map(async (kind) => {
            const [settings, last] = await Promise.all([getDigestSettings(kind), lastDigestSend(kind.id)]);
            const slots = kind.slots ?? ["morning", "evening"];
            const times = slots.map((s) =>
                s === "morning" ? hhmm(settings.morningHour, settings.morningMinute) : hhmm(settings.eveningHour, settings.eveningMinute),
            );
            return {
                id: kind.id,
                label: kind.label,
                description: kind.description,
                enabled: settings.enabled,
                when: `${whichDays(kind.weekdays)} at ${times.join(" and ")}`,
                recipients: settings.recipients,
                attach_excel: settings.attachExcel,
                last_sent_at: last?.sent_at ?? null,
                last_sent_for: last?.digest_date ?? null,
                settings_href: kind.settingsHref ?? null,
            };
        }),
    );
    return successResponse({ reports, can_edit_settings: SETTINGS_ROLES.includes(user.role) });
});

const Body = z.object({ kind: z.string().min(1) });

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(VIEW_ROLES);
    const kind = digestKind(Body.parse(await req.json()).kind);
    if (!kind) throw Object.assign(new Error("Unknown report."), { status: 404 });
    if (!user.email) throw Object.assign(new Error("Your login has no email address to send to."), { status: 400 });
    const result = await runDigest({ kind, slot: "test", triggeredBy: "manual", toOverride: [user.email] });
    return successResponse({ sent_to: user.email, result });
});
