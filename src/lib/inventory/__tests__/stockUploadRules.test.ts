import { describe, expect, it } from "vitest";

import { decideStockTransfer, decideStockUpload, inventoryListScope, stockUploadMode } from "@/lib/inventory/stockUploadRules";

describe("decideStockUpload (ID 173)", () => {
    it("lets Admin, Inventory Manager and partner upload to any dealer", () => {
        for (const role of ["admin", "inventory_manager", "partner"]) {
            expect(decideStockUpload({ role, requestedDealerId: "ACC-1", ownDealerCode: null })).toEqual({
                ok: true,
                dealerId: "ACC-1",
                scope: "any",
            });
        }
    });

    it("asks staff to pick a dealer", () => {
        const d = decideStockUpload({ role: "admin", requestedDealerId: "  ", ownDealerCode: null });
        expect(d.ok).toBe(false);
        if (!d.ok) expect(d.status).toBe(400);
    });

    it("lets a dealer upload to its own account, taken from the login", () => {
        expect(decideStockUpload({ role: "dealer", requestedDealerId: null, ownDealerCode: "ACC-7" })).toEqual({
            ok: true,
            dealerId: "ACC-7",
            scope: "own",
        });
        expect(decideStockUpload({ role: "dealer", requestedDealerId: "ACC-7", ownDealerCode: "ACC-7" }).ok).toBe(true);
    });

    it("refuses a dealer naming another dealer", () => {
        const d = decideStockUpload({ role: "dealer", requestedDealerId: "ACC-8", ownDealerCode: "ACC-7" });
        expect(d.ok).toBe(false);
        if (!d.ok) expect(d.status).toBe(403);
    });

    it("refuses a dealer login with no dealer account", () => {
        const d = decideStockUpload({ role: "dealer", requestedDealerId: "ACC-7", ownDealerCode: null });
        expect(d.ok).toBe(false);
        if (!d.ok) expect(d.status).toBe(403);
    });

    it("refuses everyone else, Sales Head and Ops included", () => {
        for (const role of ["sales_head", "ops_manager", "super_admin", "ceo", "inside_sales_rep", "asm", "user", "", null]) {
            const d = decideStockUpload({ role, requestedDealerId: "ACC-1", ownDealerCode: "ACC-1" });
            expect(d.ok).toBe(false);
            if (!d.ok) expect(d.status).toBe(403);
        }
    });
});

describe("stockUploadMode (ID 173)", () => {
    it("maps roles to what the page offers", () => {
        expect(stockUploadMode("partner")).toBe("any");
        expect(stockUploadMode("dealer")).toBe("own");
        expect(stockUploadMode("sales_head")).toBe("none");
        expect(stockUploadMode(undefined)).toBe("none");
    });
});

describe("decideStockTransfer (ID 173)", () => {
    it("lets Admin, Inventory Manager and partner move stock between any dealers", () => {
        for (const role of ["admin", "inventory_manager", "partner"]) {
            expect(
                decideStockTransfer({ role, sourceDealerId: "ACC-1", targetDealerId: "ACC-2", ownDealerCode: null }),
            ).toEqual({ ok: true, sourceDealerId: "ACC-1", targetDealerId: "ACC-2", scope: "any" });
        }
    });

    it("asks staff for the source dealer", () => {
        const d = decideStockTransfer({ role: "admin", sourceDealerId: "", targetDealerId: "ACC-2", ownDealerCode: null });
        expect(d.ok).toBe(false);
        if (!d.ok) expect(d.status).toBe(400);
    });

    it("lets a dealer move only its own stock, source taken from the login", () => {
        expect(
            decideStockTransfer({ role: "dealer", sourceDealerId: null, targetDealerId: "ACC-2", ownDealerCode: "ACC-7" }),
        ).toEqual({ ok: true, sourceDealerId: "ACC-7", targetDealerId: "ACC-2", scope: "own" });
        const other = decideStockTransfer({ role: "dealer", sourceDealerId: "ACC-8", targetDealerId: "ACC-7", ownDealerCode: "ACC-7" });
        expect(other.ok).toBe(false);
        if (!other.ok) expect(other.status).toBe(403);
        const unlinked = decideStockTransfer({ role: "dealer", sourceDealerId: null, targetDealerId: "ACC-2", ownDealerCode: null });
        expect(unlinked.ok).toBe(false);
        if (!unlinked.ok) expect(unlinked.status).toBe(403);
    });

    it("refuses the same dealer on both sides and a missing target", () => {
        const same = decideStockTransfer({ role: "dealer", sourceDealerId: null, targetDealerId: "ACC-7", ownDealerCode: "ACC-7" });
        expect(same.ok).toBe(false);
        if (!same.ok) expect(same.status).toBe(400);
        const none = decideStockTransfer({ role: "admin", sourceDealerId: "ACC-1", targetDealerId: " ", ownDealerCode: null });
        expect(none.ok).toBe(false);
        if (!none.ok) expect(none.status).toBe(400);
    });

    it("refuses everyone else, Sales Head and Ops included", () => {
        for (const role of ["sales_head", "ops_manager", "super_admin", "ceo", "user", "", null]) {
            const d = decideStockTransfer({ role, sourceDealerId: "ACC-1", targetDealerId: "ACC-2", ownDealerCode: "ACC-1" });
            expect(d.ok).toBe(false);
            if (!d.ok) expect(d.status).toBe(403);
        }
    });
});

describe("inventoryListScope (ID 173, the plain stock list)", () => {
    it("back office and the CEO see every dealer", () => {
        for (const r of ["admin", "ceo", "ops_manager", "inventory_manager", "sales_head", "partner"]) expect(inventoryListScope(r), r).toBe("any");
    });
    it("a dealer sees its own stock only", () => expect(inventoryListScope("dealer")).toBe("own"));
    it("everyone else is refused", () => {
        for (const r of ["inside_sales_rep", "asm", "sales_manager", "nbfc_partner", "", null]) expect(inventoryListScope(r), String(r)).toBe("none");
    });
});
