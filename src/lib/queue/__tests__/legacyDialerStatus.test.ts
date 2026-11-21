// The legacy /api/ai-dialer/status poll must never dial or close a campaign
// (Howrah part 1, 19 Nov 2026: closed with 22 retries booked).

import { describe, expect, it } from "vitest";
import { campaignSessionEnded, legacyTimeoutMayAdvance } from "@/lib/queue/legacyDialerStatus";

describe("legacyTimeoutMayAdvance", () => {
    it("never advances a session that belongs to a campaign", () => {
        expect(legacyTimeoutMayAdvance({ campaignId: "camp_mwn976x0_kowwedl1" })).toBe(false);
    });

    it("still advances a manual queue (no campaign)", () => {
        expect(legacyTimeoutMayAdvance({ campaignId: null })).toBe(true);
    });
});

describe("campaignSessionEnded", () => {
    it.each(["running", "paused", "scheduled", "draft"])("keeps the session while %s", (s) => {
        expect(campaignSessionEnded(s)).toBe(false);
    });

    it.each(["completed", "stopped", "failed", null, undefined])("clears it when %s", (s) => {
        expect(campaignSessionEnded(s)).toBe(true);
    });
});
