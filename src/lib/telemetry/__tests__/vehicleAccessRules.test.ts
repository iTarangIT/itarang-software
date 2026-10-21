import { describe, expect, it } from "vitest";

import {
    DEALER_MAX_FEED_HOURS,
    DEFAULT_FEED_HOURS,
    DEFAULT_TRIP_LIMIT,
    MAX_TRIP_LIMIT,
    ALL_VEHICLES_DEVICE_ID,
    alertVehicleNumber,
    authFailureStatus,
    capDealerRange,
    feedHours,
    fleetMapLogEntries,
    mayOpenVehicle,
    tripLimit,
    tripWindowHours,
} from "@/lib/telemetry/vehicleAccessRules";

describe("mayOpenVehicle (ID 181)", () => {
    const mapped = ["MH12AB1234", "MH12CD5678"];

    it("lets a dealer open its own mapped vehicle", () => {
        expect(mayOpenVehicle({ role: "dealer", vehicleNumber: "MH12AB1234", mappedVehicleNumbers: mapped })).toBe(true);
    });

    it("refuses a dealer another dealer's vehicle", () => {
        expect(mayOpenVehicle({ role: "dealer", vehicleNumber: "KA01ZZ0001", mappedVehicleNumbers: mapped })).toBe(false);
    });

    it("refuses a dealer with no dealer code (no mapped list)", () => {
        expect(mayOpenVehicle({ role: "dealer", vehicleNumber: "MH12AB1234", mappedVehicleNumbers: null })).toBe(false);
        expect(mayOpenVehicle({ role: "dealer", vehicleNumber: "MH12AB1234", mappedVehicleNumbers: [] })).toBe(false);
    });

    it("refuses an empty vehicle number even when the list holds blanks", () => {
        expect(mayOpenVehicle({ role: "dealer", vehicleNumber: " ", mappedVehicleNumbers: [" "] })).toBe(false);
    });

    it("leaves the CEO unchanged", () => {
        expect(mayOpenVehicle({ role: "ceo", vehicleNumber: "KA01ZZ0001", mappedVehicleNumbers: null })).toBe(true);
    });

    it("refuses every other role", () => {
        expect(mayOpenVehicle({ role: "sales_head", vehicleNumber: "MH12AB1234", mappedVehicleNumbers: mapped })).toBe(false);
    });
});

describe("feedHours (ID 181)", () => {
    it("defaults to 24 hours", () => {
        expect(feedHours(null, "dealer")).toBe(DEFAULT_FEED_HOURS);
        expect(feedHours("abc", "ceo")).toBe(DEFAULT_FEED_HOURS);
        expect(feedHours("-5", "dealer")).toBe(DEFAULT_FEED_HOURS);
        expect(feedHours("0", "dealer")).toBe(DEFAULT_FEED_HOURS);
    });

    it("caps a dealer at 7 days", () => {
        expect(feedHours("100000", "dealer")).toBe(DEALER_MAX_FEED_HOURS);
        expect(feedHours("168", "dealer")).toBe(168);
        expect(feedHours("48", "dealer")).toBe(48);
    });

    it("keeps the CEO window uncapped", () => {
        expect(feedHours("720", "ceo")).toBe(720);
    });
});

describe("tripLimit (ID 181)", () => {
    it("defaults and caps", () => {
        expect(tripLimit(undefined)).toBe(DEFAULT_TRIP_LIMIT);
        expect(tripLimit("0")).toBe(DEFAULT_TRIP_LIMIT);
        expect(tripLimit("5")).toBe(5);
        expect(tripLimit("99999")).toBe(MAX_TRIP_LIMIT);
    });
});

describe("authFailureStatus (ID 181)", () => {
    it("maps a missing session (redirect to login) to 401", () => {
        expect(authFailureStatus(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" }))).toBe(401);
    });

    it("maps a wrong role to 403", () => {
        expect(authFailureStatus(Object.assign(new Error("Forbidden"), { status: 403 }))).toBe(403);
    });

    it("leaves server errors alone", () => {
        expect(authFailureStatus(new Error("boom"))).toBeNull();
        expect(authFailureStatus(null)).toBeNull();
    });
});

describe("alertVehicleNumber (ID 181)", () => {
    it("reads the vehicle out of an alert id", () => {
        expect(alertVehicleNumber("MH12AB1234|low_soc|1760000000")).toBe("MH12AB1234");
    });

    it("rejects junk", () => {
        expect(alertVehicleNumber("")).toBeNull();
        expect(alertVehicleNumber(42)).toBeNull();
        expect(alertVehicleNumber("|x|1")).toBeNull();
    });
});

describe("tripWindowHours (ID 181, 18 Oct)", () => {
    it("caps a dealer's trips at the same 7 days as the GPS trail", () => {
        expect(tripWindowHours("dealer")).toBe(DEALER_MAX_FEED_HOURS);
        expect(DEALER_MAX_FEED_HOURS).toBe(168);
    });

    it("leaves the CEO uncapped", () => {
        expect(tripWindowHours("ceo")).toBeNull();
    });
});

describe("capDealerRange (ID 181, 18 Oct)", () => {
    const now = new Date("2026-10-21T12:00:00.000Z");
    const sevenDaysAgo = new Date("2026-10-14T12:00:00.000Z");

    it("trims a dealer's range that starts more than 7 days ago", () => {
        const r = capDealerRange({
            role: "dealer",
            from: new Date("2026-09-01T00:00:00.000Z"),
            to: new Date("2026-10-21T23:59:59.999Z"),
            now,
        });
        expect(r.from.toISOString()).toBe(sevenDaysAgo.toISOString());
        expect(r.capped).toBe(true);
        expect(r.empty).toBe(false);
    });

    it("returns nothing for a dealer range wholly older than 7 days", () => {
        const r = capDealerRange({
            role: "dealer",
            from: new Date("2026-09-01T00:00:00.000Z"),
            to: new Date("2026-09-30T23:59:59.999Z"),
            now,
        });
        expect(r.capped).toBe(true);
        expect(r.empty).toBe(true);
    });

    it("leaves a dealer range inside the last 7 days alone", () => {
        const from = new Date("2026-10-18T00:00:00.000Z");
        const r = capDealerRange({ role: "dealer", from, to: now, now });
        expect(r.from).toBe(from);
        expect(r.capped).toBe(false);
        expect(r.empty).toBe(false);
    });

    it("does not trim NBFC, admin or CEO callers", () => {
        for (const role of ["nbfc", "admin", "ceo"]) {
            const from = new Date("2026-01-01T00:00:00.000Z");
            const r = capDealerRange({ role, from, to: now, now });
            expect(r.from).toBe(from);
            expect(r.capped).toBe(false);
        }
    });
});

describe("fleetMapLogEntries (ID 181, 18 Oct)", () => {
    it("writes one row per vehicle a dealer was shown, deduped and trimmed", () => {
        expect(fleetMapLogEntries("dealer", ["MH12AB1234", " MH12AB1234 ", "KA01ZZ0001", null, ""])).toEqual([
            { deviceId: "MH12AB1234", vehicleNumber: "MH12AB1234" },
            { deviceId: "KA01ZZ0001", vehicleNumber: "KA01ZZ0001" },
        ]);
    });

    it("writes nothing when a dealer was shown nothing", () => {
        expect(fleetMapLogEntries("dealer", [])).toEqual([]);
    });

    it("writes a single whole-fleet row for the CEO", () => {
        expect(fleetMapLogEntries("ceo", ["MH12AB1234", "KA01ZZ0001"])).toEqual([
            { deviceId: ALL_VEHICLES_DEVICE_ID, vehicleNumber: null },
        ]);
    });
});
