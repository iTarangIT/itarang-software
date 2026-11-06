/**
 * Tracker ID 229 — alarm when NeoDove calls (or AI dialer results) stop
 * reaching live. One sample per feed: working minutes since the last arrival
 * (src/lib/operations/callFeed.ts). The alert rule (registry
 * "calls.feed_gap") opens past 2 working hours and rings Admin, the Sales Head and Kartik (bell + email)
 * once per gap (alerts.ts: one open alert per source, cooldown); it resolves
 * on the next fresh sample under the line.
 *
 * Outside office hours the gap does not grow, so a quiet night or Sunday
 * never rings. A feed that has never received anything on this database is
 * skipped (a fresh environment, not a stall).
 */
import { rootCauseMessage } from "@/lib/operations/errors";
import { CALL_FEED_LABEL, loadCallFeedStatus } from "@/lib/operations/callFeed";

import type { CollectedSample, OpsCollector } from "../types";
import { MINUTE } from "../types";

export const callFeedCollector: OpsCollector = {
    id: "vendor.call_feed",
    label: "Calls reaching live (NeoDove, AI dialer)",
    intervalMs: 5 * MINUTE,
    timeoutMs: 15_000,

    async run(): Promise<CollectedSample[]> {
        try {
            const { now, feeds } = await loadCallFeedStatus();
            return feeds
                .filter((f) => f.lastAt && f.gapWorkingMinutes != null)
                .map((f) => ({
                    metric_key: "calls.feed_gap",
                    source: f.feed,
                    value_num: f.gapWorkingMinutes as number,
                    meta: { last_at: f.lastAt, measured_at: now, label: CALL_FEED_LABEL[f.feed] },
                }));
        } catch (err) {
            console.error("[ops:call_feed] probe failed:", rootCauseMessage(err));
            return [];
        }
    },
};
