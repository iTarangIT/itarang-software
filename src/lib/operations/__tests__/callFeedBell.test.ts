import { describe, expect, it } from "vitest";

import { CALL_FEED_METRIC, callFeedBell, callFeedTone, renotifiesOnCooldown } from "../callFeedText";

describe("ID 229 (17 Nov): the call-feed bell rings once, in plain words", () => {
    it("a call-feed alarm never re-rings on cooldown; other alarms still do", () => {
        expect(renotifiesOnCooldown(CALL_FEED_METRIC)).toBe(false);
        expect(renotifiesOnCooldown("rds.connections_pct")).toBe(true);
    });

    it("bell text names the feed and the working-time gap, never calls.feed_gap", () => {
        const warn = callFeedBell("warn", "neodove", 135);
        expect(warn.title).toBe("Warning — calls not reaching live: NeoDove");
        expect(warn.message).toContain("2 h 15 m");
        const crit = callFeedBell("crit", "ai_dialer", 250);
        expect(crit.title).toBe("Urgent — calls not reaching live: AI dialer");
        expect(crit.message).toContain("4 h 10 m");
        const ok = callFeedBell("resolved", "neodove", 0);
        expect(ok.title).toBe("Calls reaching live again: NeoDove");
        for (const b of [warn, crit, ok]) {
            expect(b.title + b.message).not.toContain("calls.feed_gap");
        }
    });

    it("board tile: amber past 2 working hours, red past 4", () => {
        expect(callFeedTone(null)).toBe("unknown");
        expect(callFeedTone(0)).toBe("ok");
        expect(callFeedTone(119)).toBe("ok");
        expect(callFeedTone(120)).toBe("warn");
        expect(callFeedTone(240)).toBe("crit");
    });
});
