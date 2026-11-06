import { describe, expect, it } from "vitest";
import { clearedLines, lineVerdict } from "../oemListPriceFix";

const oem = [{ asset_type: "battery", product_id: "B1", oem_price: "41000.00" }];
const none = () => false;

describe("ID 205: which old list prices are the OEM figure", () => {
    it("clears a list price equal to the OEM price when no real list price existed", () => {
        expect(lineVerdict({ asset_type: "battery", product_id: "B1", list_price: 41000 }, oem, none)).toBe("clear");
    });

    it("keeps a list price that came from the price book", () => {
        expect(lineVerdict({ asset_type: "battery", product_id: "B1", list_price: 41000 }, oem, () => true)).toBe(
            "keep_real_list_price",
        );
    });

    it("leaves a figure that is not the OEM price, and reports it", () => {
        expect(lineVerdict({ asset_type: "battery", product_id: "B1", list_price: 45000 }, oem, none)).toBe("unclear");
        expect(lineVerdict({ asset_type: "charger", product_id: "C1", list_price: 900 }, oem, none)).toBe("unclear");
    });

    it("ignores lines with no list price", () => {
        expect(lineVerdict({ asset_type: "battery", product_id: "B1", list_price: null }, oem, none)).toBe("no_list_price");
    });

    it("nulls only the cleared lines and counts them", () => {
        const r = clearedLines(
            [
                { asset_type: "battery", product_id: "B1", list_price: 41000, unit_price: 39000 },
                { asset_type: "charger", product_id: "C1", list_price: 900 },
            ],
            oem,
            none,
        );
        expect(r.cleared).toBe(1);
        expect(r.unclear).toBe(1);
        expect(r.lines[0]).toEqual({ asset_type: "battery", product_id: "B1", list_price: null, unit_price: 39000 });
        expect(r.lines[1].list_price).toBe(900);
    });
});
