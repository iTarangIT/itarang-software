import { describe, expect, it } from "vitest";
import { owedByCustomer, projectReceivable, type ProjectionRow } from "@/lib/sales/paymentSyncProjectionRules";

const inv = (id: string, owe_key: string, balance: number, status = "sent", name = owe_key): ProjectionRow => ({
    source: "drive",
    id,
    owe_key,
    balance,
    status,
    name,
});
const cn = (id: string, owe_key: string, balance: number): ProjectionRow => ({
    source: "credit",
    id,
    owe_key,
    balance,
    status: "credit_note",
    name: owe_key,
});

describe("receivable before → after a Vyapar upload", () => {
    it("same netting as the receivables page: credit nets the customer, never below zero", () => {
        const m = owedByCustomer([inv("1", "A", 100000), cn("c1", "A", -30000), inv("2", "B", 5000), cn("c2", "B", -9000), cn("c3", "C", -500)]);
        expect(m.get("A")).toBe(70000);
        expect(m.get("B")).toBe(0);
        expect(m.has("C")).toBe(false); // a credit with nothing owed is not netted
    });

    it("a part payment lowers the invoice; a full payment takes it out", () => {
        const rows = [inv("1", "A", 100000), inv("2", "B", 50000)];
        const p = projectReceivable(
            rows,
            new Map([
                ["drive:1", { balance: 40000, status: "partially_paid" }],
                ["drive:2", { balance: 0, status: "paid" }],
            ]),
        );
        expect(p).toMatchObject({ before: 150000, after: 40000 });
        expect(p.customers.map((c) => [c.owe_key, c.before, c.after])).toEqual([
            ["A", 100000, 40000],
            ["B", 50000, 0],
        ]);
    });

    it("once the customer is paid up, their credit note stops netting", () => {
        const rows = [inv("1", "A", 10000), cn("c1", "A", -4000)];
        const p = projectReceivable(rows, new Map([["drive:1", { balance: 0, status: "paid" }]]));
        expect(p).toMatchObject({ before: 6000, after: 0 });
    });

    it("a credit note used in Vyapar (E-368) stops reducing the customer's balance", () => {
        const rows = [inv("1", "A", 100000), cn("c1", "A", -40000)];
        const p = projectReceivable(rows, new Map([["credit:c1", { balance: 0, status: "credit_note" }]]));
        expect(p).toMatchObject({ before: 60000, after: 100000 });
    });

    it("an invoice paid in the CRM that Vyapar shows part-paid comes back", () => {
        const rows = [inv("1", "A", 0, "paid")];
        const p = projectReceivable(rows, new Map([["drive:1", { balance: 25000, status: "partially_paid" }]]));
        expect(p).toMatchObject({ before: 0, after: 25000 });
    });

    it("a void or draft row keeps its status; a new register invoice is added", () => {
        const rows = [inv("1", "A", 5000, "draft"), inv("2", "B", 7000)];
        const p = projectReceivable(
            rows,
            new Map([["drive:1", { balance: 5000, status: "sent" }]]),
            [inv("new:x", "B", 3000)],
        );
        expect(p).toMatchObject({ before: 7000, after: 10000 });
    });

    it("re-uploading the same file: nothing moves", () => {
        const rows = [inv("1", "A", 100000), cn("c1", "A", -1000)];
        expect(projectReceivable(rows, new Map())).toEqual({ before: 99000, after: 99000, customers: [] });
    });
});
