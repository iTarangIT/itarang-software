import { describe, expect, it } from "vitest";

import { csvCells, parseInterestCsv } from "@/lib/leads/interestUpload";

describe("bulk interest upload parsing (A33)", () => {
    it("reads lead_id or phone with hot / warm / cold in any case and H/W/C", () => {
        const { rows, error } = parseInterestCsv("lead_id,phone,Interest\nL-1,,Hot\n,+91 98765 43210,w\n,9876500000,COLD\n");
        expect(error).toBeNull();
        expect(rows.map((r) => [r.leadId, r.phone, r.level, r.error])).toEqual([
            ["L-1", null, "hot", null],
            [null, "9876543210", "warm", null],
            [null, "9876500000", "cold", null],
        ]);
    });

    it("flags bad rows with the line they are on", () => {
        const { rows } = parseInterestCsv("phone,interest\n12345,hot\n9876543210,lukewarm\n9876543211,\n");
        expect(rows.map((r) => [r.line, r.error])).toEqual([
            [2, "Phone has fewer than 10 digits"],
            [3, '"lukewarm" is not hot, warm or cold'],
            [4, "No interest level"],
        ]);
    });

    it("needs an interest column and a way to find the lead", () => {
        expect(parseInterestCsv("phone,name\n9876543210,A").error).toMatch(/No interest column/);
        expect(parseInterestCsv("name,interest\nA,hot").error).toMatch(/No lead_id or phone/);
        expect(parseInterestCsv("").error).toMatch(/empty/);
    });

    it("splits quoted cells", () => {
        expect(csvCells('"Shakti, Pune","say ""hi""",hot')).toEqual(["Shakti, Pune", 'say "hi"', "hot"]);
    });
});
