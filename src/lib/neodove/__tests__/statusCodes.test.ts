import { describe, expect, it } from "vitest";

import {
    istDateTime,
    neodoveStatusLabel,
    neodoveStatusName,
    parseNeodoveFollowUp,
    readableNeodoveRemarks,
} from "../statusCodes";

describe("NeoDove status codes (ID 242, measured on live 26 Nov)", () => {
    it("the name NeoDove sent wins over the table", () => {
        expect(neodoveStatusName("6", "Follow-Up")).toBe("Follow-Up");
    });
    it("a code with no name reads from the table", () => {
        expect(neodoveStatusName("6", null)).toBe("In-Progress");
        expect(neodoveStatusName("5", "")).toBe("In-Progress");
        expect(neodoveStatusName("1", null)).toBe("Uncontacted");
        expect(neodoveStatusName("-6", null)).toBe("In-Progress");
        expect(neodoveStatusName("7", null)).toBe("Lost");
        expect(neodoveStatusName("10", null)).toBe("Converted");
    });
    it("a CSV-imported name in the code field is the name itself", () => {
        expect(neodoveStatusName("In-Progress", null)).toBe("In-Progress");
        expect(neodoveStatusLabel("Lost", "")).toBe("Lost");
    });
    it("an unknown code is never guessed", () => {
        expect(neodoveStatusName("42", null)).toBeNull();
        expect(neodoveStatusLabel("42", null)).toBe("NeoDove code 42");
        expect(neodoveStatusLabel(null, null)).toBeNull();
    });
});

describe("parseNeodoveFollowUp", () => {
    it("reads epoch millis as a number or a string", () => {
        expect(parseNeodoveFollowUp(1785787221858, null)?.getTime()).toBe(1785787221858);
        expect(parseNeodoveFollowUp("1785787221858", null)?.getTime()).toBe(1785787221858);
    });
    it("falls back to the IST text", () => {
        const d = parseNeodoveFollowUp(null, "27/11/2026, 11:00 am");
        expect(d?.toISOString()).toBe("2026-11-27T05:30:00.000Z");
        expect(parseNeodoveFollowUp(null, "27/11/2026, 12:15 pm")?.toISOString()).toBe("2026-11-27T06:45:00.000Z");
        expect(parseNeodoveFollowUp(null, "27/11/2026, 12:15 am")?.toISOString()).toBe("2026-11-26T18:45:00.000Z");
    });
    it("nothing usable → null", () => {
        expect(parseNeodoveFollowUp(0, "")).toBeNull();
        expect(parseNeodoveFollowUp("abc", "tomorrow")).toBeNull();
        expect(parseNeodoveFollowUp(undefined, undefined)).toBeNull();
    });
    it("formats in IST", () => {
        expect(istDateTime(new Date("2026-11-27T05:30:00.000Z"))).toBe("27 Nov 2026, 11:00 am");
    });
});

describe("readableNeodoveRemarks — old stored lines read right on screen", () => {
    it("replaces a known code with its name", () => {
        expect(readableNeodoveRemarks("[NeoDove] Disposition: status code 6 · Stage: Cold")).toBe(
            "[NeoDove] Disposition: In-Progress (NeoDove code 6) · Stage: Cold",
        );
        expect(readableNeodoveRemarks("[NeoDove] Disposition: status code -5 · Tag: Busy")).toBe(
            "[NeoDove] Disposition: In-Progress (NeoDove code -5) · Tag: Busy",
        );
    });
    it("keeps an unknown code as a code and leaves other lines alone", () => {
        expect(readableNeodoveRemarks("[NeoDove] Disposition: status code 42")).toBe("[NeoDove] Disposition: NeoDove code 42");
        expect(readableNeodoveRemarks("Called, said status code 6")).toBe("Called, said status code 6");
        expect(readableNeodoveRemarks(null)).toBeNull();
    });
});
