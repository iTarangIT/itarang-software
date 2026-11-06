// ID 224 point 2 — CSV dates in IST, one format; About sheet states the dates.
import { describe, expect, it } from "vitest";

import { buildCsv, csvDateIst, csvDateTimeIst, parseInstant } from "@/lib/exports/datasets/workbook";
import type { DatasetSheet } from "@/lib/exports/datasets/types";

describe("parseInstant", () => {
    it("reads naive timestamps as UTC, whatever the server's zone", () => {
        expect(parseInstant("2026-11-03 10:45:00")?.toISOString()).toBe("2026-11-03T10:45:00.000Z");
        expect(parseInstant("2026-11-03T10:45:00.123")?.toISOString()).toBe("2026-11-03T10:45:00.123Z");
    });
    it("keeps instants with a zone, Dates and date-only values", () => {
        expect(parseInstant("2026-11-03T10:45:00+05:30")?.toISOString()).toBe("2026-11-03T05:15:00.000Z");
        expect(parseInstant(new Date("2026-11-03T10:45:00Z"))?.toISOString()).toBe("2026-11-03T10:45:00.000Z");
        expect(parseInstant("2026-11-03")?.toISOString()).toBe("2026-11-03T00:00:00.000Z");
        expect(parseInstant("")).toBeNull();
        expect(parseInstant("not a date")).toBeNull();
    });
});

describe("CSV date cells", () => {
    it("a 4:15 pm IST call reads 16:15 from every stored shape", () => {
        expect(csvDateTimeIst("2026-11-03 10:45:00")).toBe("2026-11-03 16:15");
        expect(csvDateTimeIst("2026-11-03T10:45:00Z")).toBe("2026-11-03 16:15");
        expect(csvDateTimeIst(new Date("2026-11-03T10:45:00Z"))).toBe("2026-11-03 16:15");
    });
    it("a late-evening UTC timestamp falls on the next IST day", () => {
        expect(csvDateIst("2026-11-03T20:00:00Z")).toBe("2026-11-04");
        expect(csvDateIst("2026-11-03")).toBe("2026-11-03");
        expect(csvDateIst(null)).toBe("");
    });
});

describe("buildCsv", () => {
    const sheet: DatasetSheet = {
        name: "Calls",
        columns: [
            { key: "at", header: "Called at", meaning: "", kind: "datetime" },
            { key: "day", header: "Day", meaning: "", kind: "date" },
            { key: "status", header: "Status", meaning: "" },
            { key: "phone", header: "Phone", meaning: "", kind: "phone" },
        ],
        rows: [{ at: "2026-11-03 10:45:00", day: "2026-11-03", status: "Assigned", phone: "9876543210" }],
    };
    it("writes IST, one format, masked phone", () => {
        const csv = buildCsv(sheet, { datasetLabel: "Calls", downloadedBy: "x", filters: {}, fullPhone: false, ownOnly: false });
        const [, row] = csv.replace(/^﻿/, "").trim().split("\r\n");
        expect(row.startsWith("2026-11-03 16:15,2026-11-03,Assigned,")).toBe(true);
        expect(row).not.toContain("9876543210");
    });
});
