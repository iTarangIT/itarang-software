import { describe, expect, it } from "vitest";

import {
    TELEGRAM_CAPTION_LIMIT,
    buildMorningCaption,
    buildUnreachableMessage,
} from "@/lib/monitor/morning-caption";
import type { MonitorOverview } from "@/lib/telemetry/monitor-queries";

const NOW = new Date("2026-09-23T02:30:00Z"); // 08:00 IST

function overview(patch: Partial<MonitorOverview> = {}): MonitorOverview {
    return {
        generatedAt: NOW.toISOString(),
        fleet: {
            fleetSize: 504,
            liveNow: 375,
            livePct: 74.4,
            reportedLast24h: 473,
            silentOver24h: 20,
            neverReported: 11,
            newestSignalAgeMs: 3 * 60_000,
            silence: {
                battery: { under_1h: 330, "1h_24h": 131, "1d_7d": 3, over_7d: 29, never: 11 },
                gps: { under_1h: 372, "1h_24h": 101, "1d_7d": 4, over_7d: 16, never: 11 },
            },
            soc: {
                buckets: { "0-20": 13, "20-40": 55, "40-60": 108, "60-80": 120, "80-100": 197 },
                below20: 13,
                withReading: 493,
                avg: 68.8,
            },
        },
        attention: [],
        alerts: { open: 145, distinctTypes: 1 },
        distance: {
            totalKm30d: 515072,
            vehicles30d: 371,
            vehicleDays30d: 9251,
            avgKmPerVehicleDay: 55.7,
            series14d: [],
        },
        mapping: {
            telemetryVehicles: 504,
            mapped: 284,
            unmapped: 220,
            withState: 282,
            withDealer: 0,
            states: 6,
        },
        notMeasurable: {
            soh: { reporting: 491, distinctValues: 1, constantValue: 100 },
            trips: { hasRows: false, tableMissing: false },
            energy: { rowsWithValue: 0, rowsInWindow: 9251 },
            dealerAttribution: { mapped: 0, total: 285 },
        },
        ...patch,
    };
}

describe("buildMorningCaption", () => {
    it("leads with the numbers someone reads on a phone at 8am", () => {
        const c = buildMorningCaption(overview(), NOW);
        expect(c).toContain("375");
        expect(c).toContain("504");
        expect(c).toContain("74.4%");
        expect(c).toContain("20 silent");
        expect(c).toContain("11 never reported");
        expect(c).toContain("145");
    });

    it("dates the card in IST, not UTC", () => {
        // 02:30Z is already the 23rd in IST; a UTC-dated card would be right
        // here by luck, so test the case where they differ.
        const lateEvening = new Date("2026-09-23T19:00:00Z"); // 00:30 IST on 24th
        expect(buildMorningCaption(overview(), lateEvening)).toContain("24 Sep");
    });

    it("flags low charge only when there is any", () => {
        expect(buildMorningCaption(overview(), NOW)).toContain("13 packs below 20%");

        const healthy = overview();
        healthy.fleet.soc.below20 = 0;
        expect(buildMorningCaption(healthy, NOW)).not.toContain("below 20%");
    });

    it("says how stale the freshest signal is", () => {
        expect(buildMorningCaption(overview(), NOW)).toContain("LIVE");

        const stale = overview();
        stale.fleet.newestSignalAgeMs = 9 * 24 * 3_600_000;
        expect(buildMorningCaption(stale, NOW)).toContain("FROZEN");
    });

    it("fits inside Telegram's caption limit even at implausible fleet sizes", () => {
        const big = overview();
        big.fleet.fleetSize = 9_999_999;
        big.fleet.liveNow = 9_999_999;
        big.alerts.open = 9_999_999;
        expect(buildMorningCaption(big, NOW).length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    });

    it("escapes HTML so a stray angle bracket cannot break parse_mode", () => {
        // The caption is sent with parse_mode=HTML. An unescaped "<" from any
        // interpolated value would make Telegram reject the whole message.
        const c = buildMorningCaption(overview(), NOW);
        const stripped = c.replace(/<\/?b>/g, "");
        expect(stripped).not.toContain("<");
    });
});

describe("buildUnreachableMessage", () => {
    it("says plainly that nothing was measured", () => {
        const m = buildUnreachableMessage("IoT VPS unreachable — tunnel down.", NOW);
        expect(m).toMatch(/unavailable|unreachable/i);
        expect(m).toContain("tunnel down");
    });

    it("escapes the reason, which is raw error text", () => {
        const m = buildUnreachableMessage('bad <script>alert("x")</script>', NOW);
        expect(m).not.toContain("<script>");
        expect(m).toContain("&lt;script&gt;");
    });
});
