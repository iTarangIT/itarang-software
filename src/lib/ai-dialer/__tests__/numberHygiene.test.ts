// B1 + D7 — mobiles only, no vehicle showrooms, one dial per number.

import { describe, expect, it } from "vitest";
import {
    classifyPhone,
    dialTimeSkip,
    isVehicleShowroom,
    phoneKey,
    planEnrolment,
} from "@/lib/ai-dialer/numberHygiene";

describe("classifyPhone", () => {
    it("reads mobiles in every stored shape", () => {
        for (const p of ["9811022422", "+919811022422", "+91 98110 22422", "09811022422", "919811022422"]) {
            expect(classifyPhone(p)).toBe("mobile");
        }
    });

    it("catches the landlines that look like mobiles after +91", () => {
        // 080-6/7 cloud-telephony numbers: last ten digits start with 8.
        expect(classifyPhone("+91 80 3771 0205")).toBe("fixed_line");
        expect(classifyPhone("+918061234567")).toBe("fixed_line");
        expect(classifyPhone("080-71234567")).toBe("fixed_line");
        // Patna 0612, Bhopal 0755: start with 6 / 7.
        expect(classifyPhone("+916122234567")).toBe("fixed_line");
        expect(classifyPhone("0755-2345678")).toBe("fixed_line");
        expect(classifyPhone("0141-3228054")).toBe("fixed_line");
    });

    it("toll-free, invalid and empty are not dialable", () => {
        expect(classifyPhone("1800-103-5454")).toBe("toll_free");
        expect(classifyPhone("+91820867778")).toBe("invalid");
        expect(classifyPhone("")).toBe("invalid");
        expect(classifyPhone(null)).toBe("invalid");
    });
});

describe("isVehicleShowroom", () => {
    it.each([
        "TVS - Kunal Automobile",
        "Bajaj Auto (Shourya Bajaj, Niphad)",
        "BGS Honda, Bhopal",
        "Ather Space Raipur",
        "Ola Electric Experience Centre",
        "Hero MotoCorp - Sai Motors",
        "Euler Motors Patna",
        "Liberty Exclusive Showroom",
    ])("skips %s", (name) => expect(isVehicleShowroom(name)).toBe(true));

    it.each([
        "Terra Motors Bhopal",
        "Aruna Electro Motors",
        "SHIVAM MOTORS",
        "Exide Care - Need Battery House",
        "TVS Battery Point", // a battery shop that names a brand
        "Honda Inverter & Solar",
        "Mahindra E-Rickshaw Dealer",
        null,
    ])("dials %s", (name) => expect(isVehicleShowroom(name)).toBe(false));
});

describe("planEnrolment", () => {
    it("keeps the first lead per number and says why the rest were skipped", () => {
        const out = planEnrolment([
            { id: "a", phone: "+919811022422", name: "Shree Batteries" },
            { id: "b", phone: "9811022422", name: "Shree Batteries (2)" }, // same number
            { id: "c", phone: "+91 80 3771 0205", name: "Exide Care - X" }, // landline
            { id: "d", phone: "+918095123456", name: "TVS - Kunal Automobile" }, // showroom
            { id: "e", phone: "", name: "No phone" },
            { id: "f", phone: "+917000123456", name: "Raj E-Rickshaw" },
        ]);
        expect(out.map((d) => [d.id, d.skip])).toEqual([
            ["a", null],
            ["b", "duplicate_number"],
            ["c", "not_mobile"],
            ["d", "vehicle_showroom"],
            ["e", "no_phone"],
            ["f", null],
        ]);
        expect(out[2].phoneType).toBe("fixed_line");
    });

    it("a skipped landline does not claim its number", () => {
        // Two rows on one landline: both are 'not a mobile', neither a duplicate.
        const out = planEnrolment([
            { id: "a", phone: "08061234567", name: null },
            { id: "b", phone: "+918061234567", name: null },
        ]);
        expect(out.map((d) => d.skip)).toEqual(["not_mobile", "not_mobile"]);
    });
});

describe("dialTimeSkip / phoneKey", () => {
    it("refuses a landline or showroom at dial time", () => {
        expect(dialTimeSkip({ phone: "+918061234567", name: null })).toBe("not_mobile");
        expect(dialTimeSkip({ phone: "+919811022422", name: "BGS Honda" })).toBe("vehicle_showroom");
        expect(dialTimeSkip({ phone: "+919811022422", name: "Shree Batteries" })).toBeNull();
    });

    it("keys on the last 10 digits", () => {
        expect(phoneKey("+91 98110 22422")).toBe("9811022422");
        expect(phoneKey("09811022422")).toBe("9811022422");
        expect(phoneKey("12345")).toBeNull();
    });
});
