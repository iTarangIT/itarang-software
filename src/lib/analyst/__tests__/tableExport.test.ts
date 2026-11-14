// 251 items 20 and 21: taking an answer's table out, links to leads and dealers, long questions.
import { describe, expect, it } from "vitest";

import { cellLink, downloadName, isLongQuestion, tableToTsv } from "../tableExport";

describe("tableToTsv", () => {
    it("writes a header and one line per row, nulls empty, tabs and newlines flattened", () => {
        expect(tableToTsv(["name", "visits"], [["Biplabh Ghosh", 7], ["A\tB\nC", null]])).toBe("name\tvisits\nBiplabh Ghosh\t7\nA B C\t");
    });
    it("keeps a decimal exactly as the database sent it", () => {
        expect(tableToTsv(["amount"], [["266300.00"]])).toBe("amount\n266300.00");
    });
});

describe("cellLink", () => {
    const columns = ["dealer_lead_id", "dealer_name", "account_id", "visits"];
    const row = ["DL-muf9zhg0-a12b447e", "Vinayak Enterprises", "ACC-00123", 3];
    it("links lead and account ids, and a name through the row's lead id", () => {
        expect(cellLink(columns, row, 0)).toBe("/inside-sales/lead/DL-muf9zhg0-a12b447e");
        expect(cellLink(columns, row, 1)).toBe("/inside-sales/lead/DL-muf9zhg0-a12b447e");
        expect(cellLink(columns, row, 2)).toBe("/my-dealers/ACC-00123");
        expect(cellLink(columns, row, 3)).toBeNull();
    });
    it("does not link text that is not a CRM id", () => {
        expect(cellLink(["lead_id"], ["12345"], 0)).toBeNull();
        expect(cellLink(["name"], ["Biplabh Ghosh"], 0)).toBeNull();
    });
    it("a dealer name links to the dealer page when the row has only an account id", () => {
        expect(cellLink(["dealer_name", "account_id"], ["Hakim Auto", "ACC-0077"], 0)).toBe("/my-dealers/ACC-0077");
    });
});

describe("downloadName / isLongQuestion", () => {
    it("names the file from the question and the IST date", () => {
        expect(downloadName("Visits by each salesperson yesterday?", new Date("2026-11-13T20:00:00Z"))).toBe(
            "visits-by-each-salesperson-yesterday-2026-11-14.xlsx",
        );
    });
    it("folds questions over 3 lines or about 280 characters", () => {
        expect(isLongQuestion("short")).toBe(false);
        expect(isLongQuestion("a\nb\nc\nd")).toBe(true);
        expect(isLongQuestion("x".repeat(281))).toBe(true);
    });
});
