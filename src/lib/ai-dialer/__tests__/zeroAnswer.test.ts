import { describe, expect, it } from "vitest";
import {
    isZeroAnswerDay,
    ZERO_ANSWER_MIN_DIALS_DEFAULT,
    zeroAnswerCampaigns,
    zeroAnswerMinDials,
    type CampaignDial,
} from "@/lib/ai-dialer/zeroAnswer";
import { readoutLines, type ReadoutRow } from "@/lib/ai-dialer/readout/readout";
import { parseDialerAlertSettings } from "@/lib/ai-dialer/dialerAlertSettings";

const notPicked = (campaignId: string): CampaignDial => ({ campaignId, l1: "Not connected", l2: "Did not pick", rule: "12" });
const machine = (campaignId: string): CampaignDial => ({ campaignId, l1: "Connected", l2: "Machine", rule: "8" });
const person = (campaignId: string): CampaignDial => ({ campaignId, l1: "Connected", l2: "Cold", rule: "15" });
const times = (n: number, f: () => CampaignDial) => Array.from({ length: n }, f);

describe("zeroAnswerCampaigns (AI dialer list item 5)", () => {
    it("flags a campaign with enough dials and no person — machines do not count as people", () => {
        const dials = [...times(15, () => notPicked("a")), ...times(5, () => machine("a"))];
        expect(zeroAnswerCampaigns(dials, 20)).toEqual([{ campaignId: "a", dials: 20, humans: 0 }]);
    });

    it("one person answering clears it", () => {
        const dials = [...times(25, () => notPicked("a")), person("a")];
        expect(zeroAnswerCampaigns(dials, 20)).toEqual([]);
    });

    it("below the threshold is not flagged; campaigns are judged apart", () => {
        const dials = [...times(19, () => notPicked("a")), ...times(30, () => notPicked("b")), person("c")];
        expect(zeroAnswerCampaigns(dials, 20).map((h) => h.campaignId)).toEqual(["b"]);
    });

    it("a 'wrong number' said by a person is a human answer", () => {
        const dials = [...times(25, () => notPicked("a")), { campaignId: "a", l1: "Not connected", l2: "Invalid", rule: "7" }];
        expect(zeroAnswerCampaigns(dials, 20)).toEqual([]);
    });
});

describe("zeroAnswerMinDials", () => {
    it("defaults, clamps and rounds", () => {
        expect(zeroAnswerMinDials(undefined)).toBe(ZERO_ANSWER_MIN_DIALS_DEFAULT);
        expect(zeroAnswerMinDials("x")).toBe(ZERO_ANSWER_MIN_DIALS_DEFAULT);
        expect(zeroAnswerMinDials(2)).toBe(5);
        expect(zeroAnswerMinDials(9999)).toBe(500);
        expect(zeroAnswerMinDials(30.4)).toBe(30);
    });

    it("is read from Settings › Dialer alerts", () => {
        expect(parseDialerAlertSettings(null).zeroAnswerMinDials).toBe(20);
        expect(parseDialerAlertSettings({ zero_answer_min_dials: 40 }).zeroAnswerMinDials).toBe(40);
    });
});

describe("readout flag", () => {
    const row = (dials: number, humans: number): ReadoutRow => ({
        day: "2026-11-13",
        dials,
        humans,
        complete: 0,
        per100: dials ? 0 : null,
        gone15Pct: null,
        inboundTotal: 0,
        inboundAnswered: 0,
        defects: { introRestartCalls: 0, slowReplyCalls: 0, slowReplyTurnsPct: null, languageFlipCalls: 0, goneIn15Calls: 0 },
    });

    it("isZeroAnswerDay", () => {
        expect(isZeroAnswerDay(row(40, 0), 20)).toBe(true);
        expect(isZeroAnswerDay(row(40, 1), 20)).toBe(false);
        expect(isZeroAnswerDay(row(10, 0), 20)).toBe(false);
    });

    it("the readout leads with ZERO ANSWERED only on such a day", () => {
        expect(readoutLines([row(40, 0)], { version: "v1", changeTested: "" })[0]).toMatch(/^ZERO ANSWERED today: 40 dials/);
        expect(readoutLines([row(40, 3)], { version: "v1", changeTested: "" })[0]).toMatch(/^Version:/);
    });
});
