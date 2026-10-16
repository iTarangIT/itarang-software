import { describe, expect, it } from "vitest";

import {
    batterySerialLines,
    classifySerials,
    cleanSerials,
    invoiceSerialTotals,
    normalizeSerial,
    serialsFromDescription,
    shouldEscalate,
    stockTaskLine,
    stockTaskProgress,
    taskComplete,
} from "@/lib/inventory/stockUploadTasks/rules";

describe("serial parsing (ID 174)", () => {
    it("normalizes and rejects non-serials", () => {
        expect(normalizeSerial(" itb 2501, ")).toBe("ITB2501");
        expect(normalizeSerial("NO")).toBeNull();
        expect(normalizeSerial("ABCD")).toBeNull(); // no digit
        expect(cleanSerials(["a1234", "A1234", "", null, "b-5678"])).toEqual(["A1234", "B-5678"]);
    });

    it("reads serials printed after 'Serial No:' in the item name", () => {
        expect(
            serialsFromDescription("LiFePO4 51.2V 105Ah (FG3WMFG00320) Orange Color\nSerial No: ITB2501, ITB2502 ,ITB2503"),
        ).toEqual(["ITB2501", "ITB2502", "ITB2503"]);
        expect(serialsFromDescription("Serial Nos.- 11111 22222")).toEqual(["11111", "22222"]);
        expect(serialsFromDescription("No serials here")).toEqual([]);
    });
});

describe("batterySerialLines (ID 174)", () => {
    const lines = [
        { line_no: 1, hsn_code: "85076000", quantity: 2, description: "Battery 51V", serials: ["S0001", "S0002"] },
        { line_no: 2, hsn_code: "85079090", quantity: 2, description: "LCD Display with Box", serials: ["P0001"] },
        { line_no: 3, hsn_code: "850440", quantity: 1, description: "Charger" },
        { line_no: 4, hsn_code: "8507", quantity: 3, description: "Battery 60V Serial No: T0001, T0002" },
    ];

    it("keeps battery lines only (parts and chargers out) and falls back to the name", () => {
        const out = batterySerialLines(lines);
        expect(out.map((l) => l.line_no)).toEqual([1, 4]);
        expect(out[0]).toEqual({ line_no: 1, quantity: 2, serials: ["S0001", "S0002"], countMatches: true });
        expect(out[1]).toEqual({ line_no: 4, quantity: 3, serials: ["T0001", "T0002"], countMatches: false });
    });

    it("totals expected = quantity, serials = distinct read", () => {
        expect(invoiceSerialTotals(batterySerialLines(lines))).toEqual({
            expected: 5,
            serials: ["S0001", "S0002", "T0001", "T0002"],
        });
    });
});

describe("classifySerials / taskComplete (ID 174)", () => {
    const stock = new Map<string, string | null>([
        ["S1", "ACC-1"],
        ["S2", "ACC-2"],
        ["S3", null],
    ]);

    it("marks in stock, under another dealer, missing", () => {
        expect(classifySerials(["S1", "S2", "S3", "S4"], stock, "ACC-1").map((s) => s.status)).toEqual([
            "in_stock",
            "other_dealer",
            "other_dealer",
            "missing",
        ]);
    });

    it("closes only when every expected serial is in the buyer's stock", () => {
        const all = classifySerials(["S1"], stock, "ACC-1");
        expect(taskComplete({ buyerAccountId: "ACC-1", expected: 1, statuses: all })).toBe(true);
        // a partial upload stays open
        expect(taskComplete({ buyerAccountId: "ACC-1", expected: 2, statuses: classifySerials(["S1", "S4"], stock, "ACC-1") })).toBe(false);
        // the reader missed a serial: never close early
        expect(taskComplete({ buyerAccountId: "ACC-1", expected: 2, statuses: all })).toBe(false);
        // unknown buyer never closes
        expect(taskComplete({ buyerAccountId: null, expected: 1, statuses: all })).toBe(false);
        // under another dealer: open
        expect(taskComplete({ buyerAccountId: "ACC-1", expected: 1, statuses: classifySerials(["S2"], stock, "ACC-1") })).toBe(false);
    });
});

describe("escalation and copy (ID 174)", () => {
    const due = new Date("2026-10-20T18:29:59.999Z");

    it("escalates an open task past its due time only", () => {
        expect(shouldEscalate("open", due, new Date("2026-10-20T18:31:00Z"))).toBe(true);
        expect(shouldEscalate("open", due, new Date("2026-10-20T10:00:00Z"))).toBe(false);
        expect(shouldEscalate("escalated", due, new Date("2026-10-25T00:00:00Z"))).toBe(false);
        expect(shouldEscalate("closed", due, new Date("2026-10-25T00:00:00Z"))).toBe(false);
        expect(shouldEscalate("open", null, new Date())).toBe(false);
    });

    it("writes the email line and the progress line", () => {
        expect(stockTaskLine(3, 1)).toBe("3 open, 1 overdue");
        expect(stockTaskProgress({ expected: 5, read: 4, inStock: 2, otherDealer: 1, buyerKnown: false })).toBe(
            "2 of 5 serials in the dealer's stock · 1 under another dealer · 1 serial not read from the invoice · buyer not matched to a dealer account",
        );
    });
});
