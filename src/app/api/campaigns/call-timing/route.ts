// ID 144 — AI dialer: when do dealers answer and talk, by weekday × hour (IST)?
//
// GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD&campaign_id=&state=&city=
//      → { grid, places }      (&format=csv → one row per weekday × hour)
// POST { window_start, window_end }
//      → sets the default calling hours new campaigns are pre-filled with.
//
// See src/lib/ai-dialer/callTiming.ts for what counts as a dial, an answer
// and a conversation.

import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import {
    CALLING_HOURS_EDIT_ROLES,
    getCallTimingGrid,
    getCallTimingPlaces,
    setDefaultCallingHours,
    type CallTimingFilters,
} from "@/lib/ai-dialer/callTiming";
import { rate, WEEKDAYS, type CallTimingCount } from "@/lib/ai-dialer/callTimingShape";
import { CALL_TIMING_ROLES } from "@/lib/leads/access";
import { csvResponse } from "@/lib/leads/queueCsv";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function parseFilters(sp: URLSearchParams): CallTimingFilters {
    const day = (k: string) => {
        const v = sp.get(k);
        return v && DAY.test(v) ? v : null;
    };
    const text = (k: string) => sp.get(k)?.trim() || null;
    return { from: day("from"), to: day("to"), campaignId: text("campaign_id"), state: text("state"), city: text("city") };
}

const pct = (part: number, whole: number) => (whole > 0 ? `${(rate(part, whole) * 100).toFixed(1)}%` : "");

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole([...CALL_TIMING_ROLES]);
    const sp = new URL(req.url).searchParams;
    const filters = parseFilters(sp);

    if (sp.get("format") === "csv") {
        const grid = await getCallTimingGrid(filters);
        const rows: Array<CallTimingCount & { day: string; hour: number }> = [];
        grid.cells.forEach((hours, d) =>
            hours.forEach((c, hour) => {
                if (c.dials > 0) rows.push({ ...c, day: WEEKDAYS[d], hour });
            }),
        );
        return csvResponse({
            rows,
            total: rows.length,
            filename: "ai-dialer-call-timing",
            columns: [
                { header: "Weekday", value: (r) => r.day },
                { header: "Hour (IST)", value: (r) => `${String(r.hour).padStart(2, "0")}:00` },
                { header: "Dials", value: (r) => String(r.dials) },
                { header: "Answered", value: (r) => String(r.answered) },
                { header: "Talked", value: (r) => String(r.talked) },
                { header: "Answer rate", value: (r) => pct(r.answered, r.dials) },
                { header: "Talk rate", value: (r) => pct(r.talked, r.dials) },
            ],
        });
    }

    const [grid, places] = await Promise.all([getCallTimingGrid(filters), getCallTimingPlaces()]);
    const canSetHours = (CALLING_HOURS_EDIT_ROLES as readonly string[]).includes(user.role);
    return successResponse({ grid, places, filters, can_set_hours: canSetHours });
});

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const Body = z.object({ window_start: z.string().regex(HHMM), window_end: z.string().regex(HHMM) });

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole([...CALLING_HOURS_EDIT_ROLES]);
    const b = Body.parse(await req.json());
    await setDefaultCallingHours(b.window_start, b.window_end, user.id);
    return successResponse({ ok: true, ...b });
});
