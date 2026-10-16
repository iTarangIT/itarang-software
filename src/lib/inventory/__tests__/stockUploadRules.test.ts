import { describe, expect, it } from "vitest";

import { decideStockUpload, stockUploadMode } from "@/lib/inventory/stockUploadRules";

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
