import { describe, expect, it, vi } from "vitest";

// itemMap imports the db client; productFor itself never touches it.
vi.mock("@/lib/db", () => ({ db: {} }));

import { cleanItemName, itemFamilyKey, productCode } from "../invoiceLines";
import { productFor } from "../itemMap";

// Spellings taken from the invoice lines on database-1 / database-2 (14 Oct 2026).
describe("item product family", () => {
    it("reads the product code, dropping leading zeros", () => {
        expect(productCode("Wiring Harness SB-75 with 10 Sq. mm(FGCOMFG000002)")).toBe("fgcomfg2");
        expect(productCode("Wiring Harness SB-75 with 10 Sq. mm(FGCOMFG00002)")).toBe("fgcomfg2");
        expect(productCode("Trontek EV Charger 51V 21A SB50 (1200W)(FGCHMFG00039)")).toBe("fgchmfg39");
        expect(productCode("EV Battery Charger 1200W 58V22Amp. SB50")).toBeNull();
    });

    it("the same product billed with serial numbers is the same family", () => {
        const plain = "Trontek Li battery Pack 61V 105Ah CAN 3W ER-69P IN(C-7550) (with IOT) (FG3WMFG00523)Orange Color";
        const withSerials = `${plain}\nSerial No.: T2L3E1MWOTDH634604, T2L3E1MWOTDH634605`;
        expect(itemFamilyKey(withSerials)).toBe(itemFamilyKey(plain));
        expect(itemFamilyKey(plain)).toBe("code:fg3wmfg523");
    });

    it("without a code, colour / warranty / punctuation / lithium-vs-li do not split a product", () => {
        expect(cleanItemName("EV Battery Charger 1200W 58V22Amp.SB50, 1year warranty")).toBe(
            cleanItemName("EV Battery Charger 1200W 58V22Amp. SB50"),
        );
        expect(cleanItemName("Trontek Lithium Battery Pack 51v 105Ah")).toBe(cleanItemName("Trontek Li battery pack 51V 105AH"));
    });

    it("different models stay different", () => {
        expect(itemFamilyKey("Trontek Li battery Pack 51V 105Ah CAN (EV) ER-59 IN (with IOT)")).not.toBe(
            itemFamilyKey("Trontek Li battery Pack 51V 105Ah CAN (EV) ER-57 IN (with IOT)"),
        );
        expect(itemFamilyKey("Trontek Li battery Pack 64V 105Ah Non-IOT")).not.toBe(itemFamilyKey("Trontek Li battery Pack 51V 105Ah Non-IOT"));
    });

    it("lookup: the exact spelling's own mapping wins, else the family's", () => {
        const fam = itemFamilyKey("LCD Display with Box V1(FGVMMFG00003)")!;
        const mapped = new Map([
            [fam, { asset_type: "paraphernalia", product_id: "P-LCD" }],
            ["lcd display with box v1(fgvmmfg00003) special", { asset_type: "paraphernalia", product_id: "P-OTHER" }],
        ]);
        expect(productFor(mapped, "LCD Display with Box V1 (FGVMMFG003)\nSerial No.: X1").product_id).toBe("P-LCD");
        expect(productFor(mapped, "LCD Display with Box V1(FGVMMFG00003) special").product_id).toBe("P-OTHER");
        expect(productFor(mapped, "Something else").product_id).toBeNull();
    });
});
