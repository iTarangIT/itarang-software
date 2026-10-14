import { describe, expect, it } from "vitest";
import {
    CAMPAIGN_KINDS,
    CAMPAIGN_KIND_LABEL,
    LEAD_ORIGINS,
    LIST_DEFAULT_ORIGIN,
    campaignRequired,
    leadSourceLabel,
    scrapeRunLabels,
    listCampaignName,
    scrapeCampaignName,
    uploadCampaignName,
} from "../leadSourceVocab";
import { CAMPAIGN_MANAGE_ROLES, canManageCampaigns } from "../campaignAccess";

// Tracker ID 81 — the campaign rules every creating path shares.

describe("campaignRequired", () => {
    it("is true for Trade event and Digital ad only", () => {
        expect(LEAD_ORIGINS.filter(campaignRequired)).toEqual(["trade_event", "digital_ad"]);
    });

    it("is false when no origin is given", () => {
        expect(campaignRequired(null)).toBe(false);
        expect(campaignRequired(undefined)).toBe(false);
        expect(campaignRequired("")).toBe(false);
        expect(campaignRequired("not_an_origin")).toBe(false);
    });
});

describe("the calling-list default origin", () => {
    it("is one of the fixed origins and never one that needs a campaign", () => {
        expect(LEAD_ORIGINS).toContain(LIST_DEFAULT_ORIGIN);
        expect(campaignRequired(LIST_DEFAULT_ORIGIN)).toBe(false);
    });
});

describe("system campaign names", () => {
    const at = new Date("2026-07-01T06:00:00Z");

    it("an upload is named after its label, else its file, and carries the batch id", () => {
        const batchId = "c10a7939-2557-4028-87ff-b1e0842deedb";
        expect(uploadCampaignName({ label: null, fileName: "saharanpur.xlsx", at, batchId })).toBe(
            "Upload · saharanpur.xlsx · 01 Jul 2026 · c10a7939",
        );
        expect(uploadCampaignName({ label: " Auto Expo ", fileName: "x.csv", at, batchId })).toMatch(
            /^Upload · Auto Expo · /,
        );
    });

    it("two uploads of the same file on the same day get different names", () => {
        const a = uploadCampaignName({ label: null, fileName: "a.csv", at, batchId: "11111111-aaaa" });
        const b = uploadCampaignName({ label: null, fileName: "a.csv", at, batchId: "22222222-aaaa" });
        expect(a).not.toBe(b);
    });

    it("a scrape run is named after its query and carries the run id", () => {
        expect(scrapeCampaignName({ query: "3w battery dealers in bhind", at, runId: "SCRAPE-20260512-cc316421" })).toBe(
            "Scrape · 3w battery dealers in bhind · 01 Jul 2026 · cc316421",
        );
        expect(scrapeCampaignName({ query: null, at, runId: "SCRAPE-20260512-cc316421" })).toMatch(/^Scrape · run · /);
    });

    it("a long query is cut so the name stays readable", () => {
        const name = scrapeCampaignName({ query: "x".repeat(300), at, runId: "SCRAPE-1-abcdefgh" });
        expect(name.length).toBeLessThan(120);
    });

    it("the same list name is the same campaign", () => {
        expect(listCampaignName(" Bajaj Leads_8th june ")).toBe("List · Bajaj Leads_8th june");
    });
});

describe("campaign kinds", () => {
    it("every kind has a label", () => {
        for (const k of CAMPAIGN_KINDS) expect(CAMPAIGN_KIND_LABEL[k]).toBeTruthy();
    });
});

describe("who may add a campaign", () => {
    it("managers can, reps cannot", () => {
        for (const r of CAMPAIGN_MANAGE_ROLES) expect(canManageCampaigns(r)).toBe(true);
        expect(canManageCampaigns("Sales_Head")).toBe(true);
        for (const r of ["inside_sales_rep", "asm", "sales_executive", "dealer", "", null, undefined]) {
            expect(canManageCampaigns(r)).toBe(false);
        }
    });
});

describe("leadSourceLabel (/leads Source column)", () => {
    it("prefers the stamped door", () => {
        expect(leadSourceLabel("scraper", "manual_upload_lead")).toBe("Scraper");
        expect(leadSourceLabel("ai_dialer", null)).toBe("AI-dialer list");
    });
    it("falls back to the door the legacy source implies", () => {
        expect(leadSourceLabel(null, "google_places")).toBe("Scraper");
        expect(leadSourceLabel(null, "manual_upload_lead")).toBe("Bulk upload");
        expect(leadSourceLabel(undefined, "ai_dialer_lead")).toBe("AI-dialer list");
    });
    it("prettifies an unknown legacy value and returns null for nothing", () => {
        expect(leadSourceLabel(null, "trade_show")).toBe("trade show");
        expect(leadSourceLabel(null, null)).toBeNull();
    });
});

describe("scrapeRunLabels (/leads Scrape run dropdown)", () => {
    it("drops the Scrape prefix and run-id tail", () => {
        const [r] = scrapeRunLabels([{ name: "Scrape · cln distributor in bhopal · 14 Oct 2026 · 9c797299" }]);
        expect(r.label).toBe("cln distributor in bhopal · 14 Oct 2026");
    });
    it("keeps the tail when two runs would read the same", () => {
        const out = scrapeRunLabels([
            { name: "Scrape · cln in patna · 14 Oct 2026 · aaaaaaaa" },
            { name: "Scrape · cln in patna · 14 Oct 2026 · bbbbbbbb" },
            { name: "Scrape · 9ap in patna · 14 Oct 2026 · cccccccc" },
        ]);
        expect(out.map((r) => r.label)).toEqual([
            "cln in patna · 14 Oct 2026 · aaaaaaaa",
            "cln in patna · 14 Oct 2026 · bbbbbbbb",
            "9ap in patna · 14 Oct 2026",
        ]);
    });
});
