import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { classifyRegisterDoc, registerPaidFor, type CrmFacts, type RegisterFacts } from "@/lib/sales/registerPaymentRules";
import { linesHash, parseInvoiceWorkbook } from "@/lib/sales/vyaparParse";

// E-370 — duplicate / updated detection on a Vyapar Sale Report upload.

const vy = (over: Partial<RegisterFacts> = {}): RegisterFacts => ({
    date: "2026-10-20",
    total: 353705,
    received: 300000,
    balance: 53705,
    cancelled: false,
    lines_hash: "aaaa0001",
    ...over,
});
const crm = (over: Partial<CrmFacts> = {}): CrmFacts => ({
    date: "2026-10-20",
    total: 353705,
    paid: 300000,
    voided: false,
    has_register_lines: true,
    ...over,
});
const classify = (doc: RegisterFacts, last: RegisterFacts | null, c: CrmFacts | null) =>
    classifyRegisterDoc({ doc, last, crm: c, expectedPaid: c ? registerPaidFor(doc.received, doc.total ?? c.total ?? 0) : null });

describe("duplicate invoice detection", () => {
    it("same number, date and amount, nothing else changed → duplicate (not imported again)", () => {
        expect(classify(vy(), vy(), crm())).toEqual({ classification: "duplicate", changes: [], drift: [] });
    });

    it("rounding within ₹1 on the total is still the same invoice", () => {
        expect(classify(vy({ total: 353705.4 }), vy(), crm()).classification).toBe("duplicate");
    });

    it("first upload after E-370 (no record of the last import): in step with the CRM → duplicate", () => {
        expect(classify(vy(), null, crm()).classification).toBe("duplicate");
    });

    it("the CRM does not have it → new", () => {
        expect(classify(vy(), null, null)).toEqual({ classification: "new", changes: [], drift: [] });
    });

    it("a cancelled invoice already void in the CRM → duplicate", () => {
        expect(classify(vy({ cancelled: true }), vy({ cancelled: true }), crm({ voided: true })).classification).toBe("duplicate");
    });
});

describe("updated invoice detection", () => {
    it("received went up since the last import → updated (received, balance)", () => {
        const r = classify(vy({ received: 353705, balance: 0 }), vy(), crm());
        expect(r.classification).toBe("updated");
        expect(r.changes).toEqual(["received", "balance"]);
        expect(r.drift).toEqual(["paid"]);
    });

    it("the amount changed in Vyapar → updated; the CRM total is re-applied", () => {
        const r = classify(vy({ total: 360000, balance: 60000 }), vy(), crm());
        expect(r.changes).toEqual(["amount", "balance"]);
        expect(r.drift).toContain("amount");
    });

    it("the same number with a different date is the same invoice, updated with Vyapar's date", () => {
        const r = classify(vy({ date: "2026-10-21" }), vy(), crm());
        expect(r).toMatchObject({ classification: "updated", changes: ["date"], drift: ["date"] });
    });

    it("items changed → updated (lines)", () => {
        expect(classify(vy({ lines_hash: "bbbb0002" }), vy(), crm()).changes).toEqual(["lines"]);
    });

    it("cancelled in Vyapar since the last import → updated, voided", () => {
        const r = classify(vy({ cancelled: true }), vy(), crm());
        expect(r).toMatchObject({ classification: "updated", changes: ["cancelled"], drift: ["cancelled"] });
    });
});

describe("payment update validation — Vyapar always wins", () => {
    it("Vyapar unchanged but a payment was typed into the CRM by hand → updated (paid re-applied)", () => {
        const r = classify(vy(), vy(), crm({ paid: 350000 }));
        expect(r).toEqual({ classification: "updated", changes: [], drift: ["paid"] });
    });

    it("Vyapar unchanged but the CRM total is a misread PDF (ITG/202627/067) → updated (amount)", () => {
        const doc = vy({ total: 56050, received: 0, balance: 56050 });
        const r = classify(doc, doc, crm({ total: 4203750, paid: 0 }));
        expect(r).toEqual({ classification: "updated", changes: [], drift: ["amount"] });
    });

    it("the CRM still has only the PDF's item lines → updated once (lines)", () => {
        expect(classify(vy(), vy(), crm({ has_register_lines: false })).drift).toEqual(["lines"]);
    });

    it("a file without payment columns never reports a payment change", () => {
        const doc = vy({ received: null, balance: null });
        expect(classifyRegisterDoc({ doc, last: vy(), crm: crm(), expectedPaid: null }).classification).toBe("duplicate");
    });
});

describe("linesHash", () => {
    const line = { item_name: "Battery 51V 140Ah", hsn: "85076000", quantity: 5, rate: 59950, amount_excl_gst: 299750 };
    it("is stable and ignores case and spacing in the item name", () => {
        expect(linesHash([line])).toBe(linesHash([{ ...line, item_name: "  battery  51V 140ah " }]));
        expect(linesHash([line])).toMatch(/^[0-9a-f]{8}$/);
    });
    it("changes when a quantity, rate or item changes; null without lines", () => {
        expect(linesHash([line])).not.toBe(linesHash([{ ...line, quantity: 6 }]));
        expect(linesHash([line])).not.toBe(linesHash([line, line]));
        expect(linesHash([])).toBeNull();
    });
});

describe("an invoice listed twice on the Sale Report", () => {
    const book = (rows: unknown[][]) => {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Sale Report");
        XLSX.utils.book_append_sheet(
            wb,
            XLSX.utils.aoa_to_sheet([
                ["Date", "Invoice No", "Party Name", "Item Name", "HSN/SAC", "Quantity", "UnitPrice", "Amount"],
                ["20/10/2026", "ITG/1", "A", "Battery", "8507", 1, 1000, "1180"],
            ]),
            "Item Details",
        );
        return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    };
    const head = ["Date", "Invoice No", "Party Name", "Total Amount", "Received/Paid Amount", "Balance Due", "Status"];

    it("is read once and the importer is told", () => {
        const r = parseInvoiceWorkbook(
            book([head, ["20/10/2026", "ITG/1", "A", "1180", "0", "1180", "Unpaid"], ["20/10/2026", "ITG/1", "A", "1180", "0", "1180", "Unpaid"]]),
            "vyapar_register",
        );
        expect(r.documents).toHaveLength(1);
        expect(r.warnings).toContain("ITG/1: listed twice on Sale Report (same figures) — read once.");
    });

    it("with different figures, the later row is used and flagged", () => {
        const r = parseInvoiceWorkbook(
            book([head, ["20/10/2026", "ITG/1", "A", "1180", "0", "1180", "Unpaid"], ["20/10/2026", "ITG/1", "A", "1180", "500", "680", "Unpaid"]]),
            "vyapar_register",
        );
        expect(r.documents[0]).toMatchObject({ amount_paid: 500, balance_due: 680 });
        expect(r.warnings).toContain("ITG/1: listed twice on Sale Report with different figures — the later row is used.");
    });
});
