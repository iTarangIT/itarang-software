import { describe, expect, it } from "vitest";
import { CROSS_CAMPAIGN_GAP_MS, dialConflict, IN_FLIGHT_WAIT_MS } from "@/lib/ai-dialer/dialGuardRule";

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
        expect(dialConflict([{ campaignId: "c1", leadId: "L2", at: ago(3 * 86_400_000) }], me)).toEqual({
            kind: "same_campaign_other_lead",
        });
    });

    it("another campaign rang it within two hours: wait until the gap ends", () => {
        const at = ago(CROSS_CAMPAIGN_GAP_MS - 60_000);
        expect(dialConflict([{ campaignId: "c2", leadId: "L1", at }], me)).toEqual({
            kind: "other_campaign_recent",
            until: new Date(at.getTime() + CROSS_CAMPAIGN_GAP_MS),
        });
    });

    it("another campaign is ringing it now: wait half an hour", () => {
        expect(dialConflict([{ campaignId: "c2", leadId: "L9", at: now, inFlight: true }], me)).toEqual({
            kind: "other_campaign_recent",
            until: new Date(now.getTime() + IN_FLIGHT_WAIT_MS),
        });
    });

    it("another campaign's dial older than two hours does not block", () => {
        expect(dialConflict([{ campaignId: "c2", leadId: "L1", at: ago(CROSS_CAMPAIGN_GAP_MS + 1000) }], me)).toBeNull();
    });
});
