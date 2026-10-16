import { describe, expect, it } from "vitest";

import {
    DEALER_MAX_FEED_HOURS,
    DEFAULT_FEED_HOURS,
    DEFAULT_TRIP_LIMIT,
    MAX_TRIP_LIMIT,
    alertVehicleNumber,
    authFailureStatus,
    feedHours,
    mayOpenVehicle,
    tripLimit,
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
