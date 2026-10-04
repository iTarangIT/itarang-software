import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseDateCell, parseInvoiceWorkbook } from "@/lib/sales/vyaparParse";

function book(sheets: Record<string, unknown[][]>): Buffer {
    const wb = XLSX.utils.book_new();
    for (const [name, rows] of Object.entries(sheets)) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
    }
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("Vyapar sales register (ID 39)", () => {
    it("finds the header row under a title, groups lines by invoice, classifies by HSN", () => {
        const buf = book({
            "Sale Report": [
                ["iTarang Technologies — Sale Report"],
                ["From 01/09/2026 to 30/09/2026"],
                ["Date", "Invoice No.", "Party Name", "Party GSTIN", "Item Name", "HSN/SAC", "Quantity", "Price/Unit", "Taxable Value", "Tax Amount", "Total", "Status"],
                ["23/09/2026", "ITD/202627/025", "Ayansh Engineering", "09GVUPP6577G1ZF", "LFP 51.2V 105Ah", "8507.60", 5, 45000, 225000, 40500, 265500, "Paid"],
                ["", "", "", "", "Charger 10A", "850440", 2, 1000, 2000, 360, 2360, ""],
                ["24/09/2026", "ITD/202627/026", "Sharma Batteries", "", "Wiring kit", "8544", 1, 500, 500, 90, 590, "Cancelled"],
                ["Total", "", "", "", "", "", 8, "", 227500, 40950, 268450, ""],
            ],
        });
        const r = parseInvoiceWorkbook(buf, "vyapar_register");
        expect(r.warnings).toEqual([]);
        expect(r.header_row).toBe(3);
        expect(r.documents).toHaveLength(2);
        const [a, b] = r.documents;
        expect(a).toMatchObject({
            number: "ITD/202627/025",
            date: "2026-09-23",
            gstin: "09GVUPP6577G1ZF",
            cancelled: false,
            doc_type: "invoice",
            taxable: 227000,
            tax: 40860,
            total: 267860,
        });
        expect(a.lines.map((l) => [l.product_class, l.quantity, l.amount_excl_gst])).toEqual([
            ["battery", 5, 225000],
            ["charger", 2, 2000],
        ]);
        expect(b).toMatchObject({ number: "ITD/202627/026", cancelled: true, gstin: null });
        expect(b.lines[0].product_class).toBe("other");
    });

    it("works without a taxable column: amount less tax, else qty × rate", () => {
        const buf = book({
            Items: [
                ["Invoice Number", "Invoice Date", "Customer Name", "GSTIN", "Product", "HSN Code", "Qty", "Rate", "Amount", "GST Amount"],
                ["ITG/1", "2026-09-01", "X", "06AALFI7813E1ZE", "Battery", "8507", 2, 100, 236, 36],
                ["ITG/2", "2026-09-02", "Y", "", "Battery", "8507", 3, 100, "", ""],
            ],
        });
        const r = parseInvoiceWorkbook(buf, "vyapar_register");
        expect(r.documents.map((d) => d.lines[0].amount_excl_gst)).toEqual([200, 300]);
    });

    it("reports a file it cannot read instead of guessing", () => {
        const r = parseInvoiceWorkbook(book({ S: [["Foo", "Bar"], [1, 2]] }), "vyapar_register");
        expect(r.documents).toEqual([]);
        expect(r.warnings[0]).toMatch(/Could not find a column for/);
    });
});

describe("GSTR-1 (ID 71)", () => {
    it("adds up the per-rate rows of one invoice; CDNR sheets are credit notes", () => {
        const buf = book({
            b2b: [
                ["GSTIN/UIN of Recipient", "Receiver Name", "Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Rate", "Taxable Value"],
                ["09GVUPP6577G1ZF", "Ayansh", "ITD/202627/025", "23-Sep-2026", 267860, "09-Uttar Pradesh", 18, 225000],
                ["09GVUPP6577G1ZF", "Ayansh", "ITD/202627/025", "23-Sep-2026", 267860, "09-Uttar Pradesh", 18, 2000],
            ],
            cdnr: [
                ["GSTIN/UIN of Recipient", "Note Number", "Note Date", "Note Value", "Taxable Value"],
                ["09GVUPP6577G1ZF", "CN/1", "25-Sep-2026", 1180, 1000],
            ],
        });
        const r = parseInvoiceWorkbook(buf, "gstr1");
        // The best-scoring sheet is read; b2b has the most columns.
        expect(r.sheet).toBe("b2b");
        expect(r.documents).toHaveLength(1);
        expect(r.documents[0]).toMatchObject({ number: "ITD/202627/025", date: "2026-09-23", taxable: 227000, total: 267860, tax: 40860 });
        const cn = parseInvoiceWorkbook(book({ cdnr: [["GSTIN/UIN of Recipient", "Note Number", "Note Date", "Note Value", "Taxable Value"], ["09GVUPP6577G1ZF", "CN/1", "25-Sep-2026", 1180, 1000]] }), "gstr1");
        expect(cn.documents[0]).toMatchObject({ number: "CN/1", doc_type: "credit_note", total: 1180, taxable: 1000 });
    });
});

describe("dates", () => {
    it("reads the formats exports use", () => {
        expect(parseDateCell("23/09/2026")).toBe("2026-09-23");
        expect(parseDateCell("23-Sep-2026")).toBe("2026-09-23");
        expect(parseDateCell("2026-09-23T00:00:00")).toBe("2026-09-23");
        expect(parseDateCell(46288)).toBe("2026-09-23");
        expect(parseDateCell(new Date(2026, 8, 23))).toBe("2026-09-23");
        expect(parseDateCell("")).toBeNull();
    });
});
