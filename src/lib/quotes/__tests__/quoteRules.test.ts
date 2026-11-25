import { describe, expect, it } from "vitest";
import {
    isPriceChangeRejection,
    priceChangeReason,
    quoteEditBlock,
    quotePriceChanges,
    versionsToSupersede,
    type QuoteVersionState,
} from "../quoteRules";

const oem = (entries: Array<[string, number]>) => new Map(entries.map(([k, v]) => [k, { oem_price: v }]));
const list = (entries: Array<[string, number]>) => new Map(entries.map(([k, v]) => [k, { list_price: v }]));

describe("quotePriceChanges (item 1)", () => {
    const evaluationLines = [{ asset_type: "battery", product_id: "b1", product_name: "LFP 51V", oem_price: 30000 }];
    const productLines = [{ asset_type: "battery", product_id: "b1", product_name: "LFP 51V", list_price: 42000 }];

    it("is empty when nothing moved", () => {
        expect(
            quotePriceChanges({ evaluationLines, productLines, liveOem: oem([["battery:b1", 30000]]), liveList: list([["battery:b1", 42000]]) }),
        ).toEqual([]);
    });

    it("reports an OEM revision and a list revision", () => {
        const c = quotePriceChanges({
            evaluationLines,
            productLines,
            liveOem: oem([["battery:b1", 31000]]),
            liveList: list([["battery:b1", 43500]]),
        });
        expect(c).toEqual([
            { product_name: "LFP 51V", kind: "oem", from: 30000, to: 31000 },
            { product_name: "LFP 51V", kind: "list", from: 42000, to: 43500 },
        ]);
    });

    it("counts a price set where the quote had none", () => {
        const c = quotePriceChanges({
            evaluationLines: [{ asset_type: "charger", product_id: "c1", oem_price: null }],
            productLines: [],
            liveOem: oem([["charger:c1", 900]]),
            liveList: list([]),
        });
        expect(c).toHaveLength(1);
        expect(c[0]).toMatchObject({ kind: "oem", from: null, to: 900 });
    });

    it("does not count a lapsed price, or a pre-E-321 line without a list_price key", () => {
        expect(
            quotePriceChanges({
                evaluationLines,
                productLines: [{ asset_type: "battery", product_id: "b1" }],
                liveOem: oem([]),
                liveList: list([["battery:b1", 1]]),
            }),
        ).toEqual([]);
    });

    it("compares numeric strings from the database as numbers", () => {
        expect(
            quotePriceChanges({
                evaluationLines: [{ asset_type: "battery", product_id: "b1", oem_price: "30000.00" }],
                productLines: [],
                liveOem: oem([["battery:b1", 30000]]),
                liveList: list([]),
            }),
        ).toEqual([]);
    });

    it("never prints the OEM numbers in the reason, but prints the list price", () => {
        const reason = priceChangeReason([
            { product_name: "LFP 51V", kind: "oem", from: 30000, to: 31000 },
            { product_name: "LFP 51V", kind: "list", from: 42000, to: 43500 },
        ]);
        expect(reason).not.toContain("30,000");
        expect(reason).not.toContain("31,000");
        expect(reason).toContain("₹42,000 → ₹43,500");
        expect(isPriceChangeRejection(reason)).toBe(true);
        expect(isPriceChangeRejection("Too low")).toBe(false);
    });
});

const v = (p: Partial<QuoteVersionState> & { version_no: number }): QuoteVersionState => ({
    id: `q${p.version_no}`,
    approval_status: "approved",
    withdrawn_at: null,
    dealer_decision: null,
    sent: false,
    ...p,
});

describe("quoteEditBlock (item 5)", () => {
    it("allows a new version when nothing was sent", () => {
        expect(quoteEditBlock([v({ version_no: 1 }), v({ version_no: 2, approval_status: "pending" })], "lead")).toBeNull();
    });

    it("refuses while an approved version is with the dealer, unanswered", () => {
        const b = quoteEditBlock([v({ version_no: 1, sent: true })], "account");
        expect(b?.version_no).toBe(1);
        expect(b?.message).toMatch(/Withdraw it first/);
    });

    it("allows again once it was withdrawn or declined", () => {
        expect(quoteEditBlock([v({ version_no: 1, sent: true, withdrawn_at: "2026-11-25" })], "lead")).toBeNull();
        expect(quoteEditBlock([v({ version_no: 1, sent: true, dealer_decision: "declined" })], "lead")).toBeNull();
    });

    it("a dealer-accepted quote is final on a lead, a finished order on an account", () => {
        const accepted = [v({ version_no: 3, sent: true, dealer_decision: "approved" })];
        expect(quoteEditBlock(accepted, "lead")?.message).toMatch(/accepted v3/);
        expect(quoteEditBlock(accepted, "account")).toBeNull();
    });
});

describe("versionsToSupersede (item 4)", () => {
    it("withdraws pending and approved-unsent versions only", () => {
        const out = versionsToSupersede([
            v({ version_no: 1, sent: true, dealer_decision: "declined" }),
            v({ version_no: 2, approval_status: "rejected" }),
            v({ version_no: 3, withdrawn_at: "x" }),
            v({ version_no: 4 }),
            v({ version_no: 5, approval_status: "pending" }),
        ]);
        expect(out.map((x) => x.version_no)).toEqual([4, 5]);
    });
});
