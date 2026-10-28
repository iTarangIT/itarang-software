// GET /api/admin/nav-counts
//
// ID 90 — the left menu's queue counts: for the signed-in role, how many items
// WAIT in each work queue that role acts on (Approvals, Reviews, Escalations,
// Ready to assign, Lead clean-up, WhatsApp onboarding; for the CEO Escalations,
// Expense and Financing approvals). One request, parallel COUNTs, each the
// queue page's own rule (src/lib/nav/queueCounts.ts). useNavCounts polls it
// every 60 s and puts each number on its menu rows (src/lib/nav/navCountKeys.ts).
//
// Replaces /api/admin/nav-activity's "new since you last opened it" numbers.

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { NAV_QUEUES_BY_ROLE, navQueueCounts } from "@/lib/nav/queueCounts";

export const dynamic = "force-dynamic";

// ID 203: the counts depend only on the role, and every open tab polls them
// every 60 s and on focus. Kept 45 s per role in this process, so a page load
// and the poll do not fire ten COUNTs each for every user at once.
const CACHE_MS = 45_000;
const cache = new Map<string, { at: number; value: ReturnType<typeof navQueueCounts> }>();

function countsFor(role: string): ReturnType<typeof navQueueCounts> {
    const hit = cache.get(role);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = navQueueCounts(role);
    value.catch(() => cache.delete(role));
    cache.set(role, { at: Date.now(), value });
    return value;
}

export const GET = withErrorHandler(async () => {
    const user = await requireRole(Object.keys(NAV_QUEUES_BY_ROLE));
    return successResponse(await countsFor(user.role));
});
