import { describe, expect, it } from "vitest";
import { movePreview, neodoveCampaignLine, type LeadNeodoveCampaign } from "../leadCampaignText";

const fmt = (iso: string) => iso.slice(0, 10);
const cur: LeadNeodoveCampaign = {
    campaign_id: "c1", name: "Nidhi calls", neodove_name: null,
    push_status: "pushed", pushed_at: "2026-11-10T05:00:00.000Z", push_error: null,
};

describe("ID 235 NeoDove campaign on the lead", () => {
    it("names the campaign and the date sent", () => {
        expect(neodoveCampaignLine(cur, fmt)).toBe("Nidhi calls, sent 2026-11-10");
        expect(neodoveCampaignLine(null, fmt)).toBe("Not sent to NeoDove");
        expect(neodoveCampaignLine({ ...cur, push_status: "failed", push_error: "HTTP 400" }, fmt)).toBe(
            "Nidhi calls, not sent: refused (HTTP 400)",
        );
    });
    it("offers the move only when the new owner has another campaign", () => {
        const t = { campaign_id: "c2", name: "Rupali calls", neodove_name: null };
        expect(movePreview(cur, t).offer).toBe(true);
        expect(movePreview(cur, { ...t, campaign_id: "c1" }).offer).toBe(false);
        expect(movePreview(cur, null).offer).toBe(false);
        expect(movePreview({ ...cur, push_status: "failed" }, t).offer).toBe(false);
        expect(movePreview(null, t).offer).toBe(false);
    });
});
