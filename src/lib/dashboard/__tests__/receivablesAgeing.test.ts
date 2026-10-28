import { describe, expect, it } from "vitest";

import {
    ageReceivables,
    matchesReceivableSearch,
    netInvoicesAfterCredits,
    netOwed,
    receivableFileNote,
    receivableSourceLabel,
    type AgeingRow,
} from "../receivablesAgeing";

const inv = (id: string, key: string, balance: number, age: number | null): AgeingRow => ({
    source: "zoho",
    id,
    owe_key: key,
    balance,
    age_days: age,
});
const cn = (id: string, key: string, amount: number, age: number | null): AgeingRow => ({
    source: "credit",
    id,
    owe_key: key,
    balance: -amount,
    age_days: age,
});

describe("netInvoicesAfterCredits (ID 89)", () => {
    it("applies a customer's credit to its oldest invoice first", () => {
        const out = netInvoicesAfterCredits([inv("a", "G1", 100, 10), inv("b", "G1", 50, 70), cn("c", "G1", 60, 5)]);
        expect(out.map((r) => [r.id, r.balance])).toEqual([["a", 90]]);
    });

    it("never nets one customer's credit against another's invoices", () => {
        const out = netInvoicesAfterCredits([inv("a", "G1", 100, 10), cn("c", "G2", 60, 5)]);
        expect(out.map((r) => [r.id, r.balance])).toEqual([["a", 100]]);
    });

    it("drops leftover credit instead of going below zero", () => {
        expect(netInvoicesAfterCredits([inv("a", "G1", 40, 10), cn("c", "G1", 100, 5)])).toEqual([]);
    });

    it("applies credit to a dated invoice before an undated one", () => {
        const out = netInvoicesAfterCredits([inv("a", "G1", 30, null), inv("b", "G1", 30, 2), cn("c", "G1", 30, 1)]);
        expect(out.map((r) => r.id)).toEqual(["a"]);
    });
});

describe("ageReceivables (ID 89)", () => {
    const rows = [
        inv("a", "G1", 100, 10),
        inv("b", "G1", 50, 70),
        cn("c", "G1", 60, 5),
        inv("d", "G2", 20, 100),
        cn("e", "G3", 500, 3),
        inv("f", "G4", 15, null),
    ];

    it("buckets add up to the total owed", () => {
        const a = ageReceivables(rows);
        expect(a.owed).toBe(netOwed(rows));
        expect(a.buckets.reduce((s, b) => s + b.amount, 0)).toBe(a.owed);
    });

    it("never counts a credit note as an invoice", () => {
        const a = ageReceivables(rows);
        expect(a.invoices).toBe(3); // a (90 left), d, f — b fully covered
        expect(a.buckets.every((b) => b.amount >= 0)).toBe(true);
        expect(a.buckets.find((b) => b.key === "61_90")).toMatchObject({ amount: 0, invoices: 0 });
        expect(a.buckets.find((b) => b.key === "no_date")).toMatchObject({ amount: 15, invoices: 1 });
    });
});

describe("ID 200 — source, file note and dealer search", () => {
    it("names a register-only invoice and says it has no PDF yet", () => {
        expect(receivableSourceLabel({ source: "drive", origin: "vyapar" })).toBe("Vyapar register");
        expect(receivableSourceLabel({ source: "zoho", origin: "zoho" })).toBe("Zoho (old)");
        expect(receivableFileNote({ document_url: null, origin: "vyapar" })).toBe("Register only, no PDF yet");
        expect(receivableFileNote({ document_url: "/api/files/x", origin: "vyapar" })).toBeNull();
    });
    it("finds a dealer by any word of its name, the customer, the invoice number or GSTIN", () => {
        const r = { dealer_name: "Ayansh Battery", customer_name: "AYANSH BATTERIES", invoice_number: "ITG/202627/012", account_id: "D-1", owe_key: "27ABCDE1234F1Z5" };
        expect(matchesReceivableSearch(r, "ayansh")).toBe(true);
        expect(matchesReceivableSearch(r, "ayansh 012")).toBe(true);
        expect(matchesReceivableSearch(r, "27abcde")).toBe(true);
        expect(matchesReceivableSearch(r, "sanchit")).toBe(false);
        expect(matchesReceivableSearch(r, "  ")).toBe(true);
    });
});
