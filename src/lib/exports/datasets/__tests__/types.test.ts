// Reports › Data downloads (ID 13) — the two pure rules every file relies on:
// how a phone number is masked, and that customer loan files carry initials.

import { describe, expect, it } from "vitest";
import { initialsOf, maskPhone, pickColumns } from "@/lib/exports/datasets/types";

describe("maskPhone", () => {
    it("keeps the first two and last three digits (98xxxxx343)", () => {
        expect(maskPhone("9876543343")).toBe("98xxxxx343");
        expect(maskPhone("+91 98765-43343")).toBe("98xxxxx343");
        expect(maskPhone("09876543343")).toBe("98xxxxx343");
    });

    it("never leaks a short or empty value", () => {
        expect(maskPhone("12345")).toBe("xxxxx");
        expect(maskPhone("")).toBeNull();
        expect(maskPhone(null)).toBeNull();
    });
});

describe("initialsOf", () => {
    it("reduces a customer name to initials", () => {
        expect(initialsOf("Ramesh Kumar Yadav")).toBe("R. K. Y.");
        expect(initialsOf("  sita ")).toBe("S.");
        expect(initialsOf(null)).toBeNull();
    });
});

describe("pickColumns", () => {
    const cols = [
        { key: "a", header: "A", meaning: "" },
        { key: "b", header: "B", meaning: "" },
        { key: "c", header: "C", meaning: "" },
    ];

    it("keeps the ticked columns in the sheet's own order", () => {
        expect(pickColumns(cols, ["c", "a"]).map((c) => c.key)).toEqual(["a", "c"]);
    });

    it("never produces a file with no columns", () => {
        expect(pickColumns(cols, [])).toEqual(cols);
        expect(pickColumns(cols, null)).toEqual(cols);
        expect(pickColumns(cols, ["nope"])).toEqual(cols);
    });
});
