import { describe, expect, it } from "vitest";
import { CROSS_CAMPAIGN_GAP_MS, dialConflict } from "@/lib/ai-dialer/dialGuardRule";

const now = new Date("2026-11-13T11:00:00+05:30");
const ago = (ms: number) => new Date(now.getTime() - ms);
const me = { campaignId: "c1", leadId: "L1", now };

describe("dialConflict (AI dialer list item 7)", () => {
    it("no earlier dial, no conflict", () => {
        expect(dialConflict([], me)).toBeNull();
    });

    it("the lead's own redials in this campaign are allowed", () => {
        expect(dialConflict([{ campaignId: "c1", leadId: "L1", at: ago(60_000) }], me)).toBeNull();
    });

    it("another lead in this campaign already rang the number — at any time", () => {
        expect(dialConflict([{ campaignId: "c1", leadId: "L2", at: ago(3 * 86_400_000) }], me)).toBe(
            "same_campaign_other_lead",
        );
    });

    it("another campaign rang it within two hours, or is ringing it now", () => {
        expect(dialConflict([{ campaignId: "c2", leadId: "L1", at: ago(CROSS_CAMPAIGN_GAP_MS - 1000) }], me)).toBe(
            "other_campaign_recent",
        );
        expect(dialConflict([{ campaignId: "c2", leadId: "L9", at: now, inFlight: true }], me)).toBe(
            "other_campaign_recent",
        );
    });

    it("another campaign's dial older than two hours does not block", () => {
        expect(dialConflict([{ campaignId: "c2", leadId: "L1", at: ago(CROSS_CAMPAIGN_GAP_MS + 1000) }], me)).toBeNull();
    });
});
