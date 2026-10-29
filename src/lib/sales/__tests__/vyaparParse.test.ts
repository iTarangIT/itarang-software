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

describe("Vyapar battery serials (ID 174)", () => {
    it("reads a serial column, one or several per cell", () => {
        const buf = book({
            Sale: [
                ["Date", "Invoice No.", "Party Name", "Item Name", "HSN/SAC", "Quantity", "Serial No/IMEI", "Amount"],
                ["23/09/2026", "ITD/1", "A", "LFP 51.2V 105Ah", "850760", 2, "ITB2501, ITB2502", 1000],
                ["", "", "", "Charger 10A", "850440", 1, "", 100],
            ],
        });
        const r = parseInvoiceWorkbook(buf, "vyapar_register");
        expect(r.columns.serial).toBe("Serial No/IMEI");
        expect(r.unknown_columns).toEqual([]);
        expect(r.documents[0].lines.map((l) => l.serials)).toEqual([["ITB2501", "ITB2502"], []]);
    });

    it("adds serial-only rows under the line above", () => {
        const buf = book({
            Sale: [
                ["Invoice No", "Item Name", "HSN", "Qty", "Serial Number"],
                ["ITD/2", "LFP 51.2V 105Ah", "850760", 3, "ITB1"],
                ["", "", "", "", "ITB2"],
                ["", "", "", "", "ITB3"],
            ],
        });
        const r = parseInvoiceWorkbook(buf, "vyapar_register");
        expect(r.documents[0].lines).toHaveLength(1);
        expect(r.documents[0].lines[0].serials).toEqual(["ITB1", "ITB2", "ITB3"]);
    });

    it("reads 'Serial No: …' from the Description column, which is no longer skipped", () => {
        const buf = book({
            Sale: [
                ["Invoice No", "Item Name", "Description", "HSN", "Qty"],
                ["ITD/3", "LFP 51.2V 105Ah", "Serial No: ITB9, ITB10", "850760", 2],
                ["ITD/4", "LFP 51.2V 105Ah", "51.2V pack, 2 yr warranty", "850760", 1],
            ],
        });
        const r = parseInvoiceWorkbook(buf, "vyapar_register");
        expect(r.columns.description).toBe("Description");
        expect(r.documents[0].lines[0]).toMatchObject({ description: "Serial No: ITB9, ITB10", serials: ["ITB9", "ITB10"] });
        // An unlabelled description is never mistaken for serials.
        expect(r.documents[1].lines[0].serials).toEqual([]);
    });

    it("does not take an 'S. No.' / 'Sr. No.' row index as a serial", () => {
        const buf = book({
            Sale: [
                ["Sr. No.", "Invoice No", "Item Name", "HSN", "Qty"],
                [1, "ITD/5", "LFP 51.2V 105Ah", "850760", 1],
            ],
        });
        const r = parseInvoiceWorkbook(buf, "vyapar_register");
        expect(r.columns.serial).toBeUndefined();
        expect(r.documents[0].lines[0].serials).toEqual([]);
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

// ID 200 (28 Oct) — Vyapar's two-sheet "Sale Report" export, shaped like the
// sample Finance shared (22 Jul to 28 Oct): payments per invoice on "Sale
// Report", the lines on "Item Details".
describe("Vyapar Sale Report + Item Details (ID 200)", () => {
    const saleReport = [
        ["iTarang Technologies"],
        ["Sale Report"],
        ["Date", "Invoice No", "Party Name", "GSTIN", "Party Phone No.", "Transaction Type", "Total Amount", "Received/Paid Amount", "Balance Due", "Due Date", "Status", "sales manager"],
        ["22/07/2026", "ITD/202627/020", "Ayansh Battery", "09GVUPP6577G1ZF", "9876543210", "Sale", "1,18,000.00", "1,18,000.00", "0.00", "", "Paid", "Sonu"],
        ["01/09/2026", "ITD/202627/030", "Ayansh Battery", "09GVUPP6577G1ZF", "9876543210", "Sale", "2,36,000.00", "36,000.00", "2,00,000.00", "15/09/2026", "Overdue 44 Days", "Sonu"],
        ["05/09/2026", "ICNH/202627/06", "Ayansh Battery", "09GVUPP6577G1ZF", "", "Credit Note", "5,900.00", "0.00", "5,900.00", "", "Unpaid", ""],
        ["06/09/2026", "ITD/202627/031", "Sharma Batteries", "", "", "Sale[Cancelled]", "", "", "", "", "Cancelled", ""],
        ["10/09/2026", "ITD/202627/032", "Verma Traders", "", "", "Sale", "59,000.00", "", "59,000.00", "", "Unpaid", ""],
        ["Total", "", "", "", "", "", "4,18,900.00", "1,54,000.00", "2,64,900.00", "", "", ""],
    ];
    const itemDetails = [
        ["Date", "Invoice No", "Party Name", "Item Name", "HSN/SAC", "Quantity", "Price/Unit", "Amount"],
        ["22/07/2026", "ITD/202627/020", "Ayansh Battery", "LFP 51.2V 105Ah", "8507", 2, 50000, "1,18,000.00"],
        ["01/09/2026", "ITD/202627/030", "Ayansh Battery", "LFP 51.2V 105Ah", "8507", 4, 50000, "2,36,000.00"],
        ["10/09/2026", "ITD/202627/032", "Verma Traders", "Charger 10A", "850440", 10, 5000, "59,000.00"],
        ["12/09/2026", "ITD/202627/033", "Gupta EV", "Wiring kit", "8544", 1, 500, "590.00"],
    ];
    const parse = () =>
        parseInvoiceWorkbook(book({ "Sale Report": saleReport, "Item Details": itemDetails }), "vyapar_register");

    it("reads both sheets, joined on the invoice number", () => {
        const r = parse();
        expect(r.sheet).toBe("Sale Report + Item Details");
        expect(r.columns).toMatchObject({ received: "Received/Paid Amount", balance: "Balance Due", due_date: "Due Date", total: "Total Amount" });
        // Phone and sales-manager columns are deliberately ignored.
        expect(r.unknown_columns.some((c) => /phone|sales manager/i.test(c))).toBe(false);
        expect(r.documents.map((d) => d.number)).toEqual([
            "ITD/202627/020",
            "ITD/202627/030",
            "ICNH/202627/06",
            "ITD/202627/031",
            "ITD/202627/032",
            "ITD/202627/033",
        ]);
        const paid = r.documents[0];
        expect(paid.lines.map((l) => [l.product_class, l.quantity])).toEqual([["battery", 2]]);
        expect(paid).toMatchObject({ gstin: "09GVUPP6577G1ZF", total: 118000, amount_paid: 118000, balance_due: 0, due_date: null, status_text: "Paid" });
    });

    it("takes payments, due dates and overdue status from the Sale Report", () => {
        const [, overdue] = parse().documents;
        expect(overdue).toMatchObject({ total: 236000, amount_paid: 36000, balance_due: 200000, due_date: "2026-09-15", status_text: "Overdue 44 Days", cancelled: false });
    });

    it("a credit note, a cancelled sale and a received-blank invoice", () => {
        const docs = parse().documents;
        expect(docs[2]).toMatchObject({ number: "ICNH/202627/06", doc_type: "credit_note", total: 5900 });
        expect(docs[3]).toMatchObject({ number: "ITD/202627/031", cancelled: true, total: null });
        // No Received figure: paid = total less the balance.
        expect(docs[4]).toMatchObject({ total: 59000, amount_paid: 0, balance_due: 59000 });
    });

    it("keeps an Item Details invoice missing from the Sale Report, without payments, and says so", () => {
        const r = parse();
        const lone = r.documents.find((d) => d.number === "ITD/202627/033")!;
        expect(lone.amount_paid).toBeUndefined();
        expect(lone.lines).toHaveLength(1);
        expect(r.warnings).toContain("ITD/202627/033: on Item Details but not on Sale Report; read without payments.");
    });

    it("a single-sheet register is read as before, with no payments", () => {
        const r = parseInvoiceWorkbook(book({ Items: itemDetails }), "vyapar_register");
        expect(r.sheet).toBe("Items");
        expect(r.documents).toHaveLength(4);
        expect(r.documents[0].amount_paid).toBeUndefined();
    });
});
