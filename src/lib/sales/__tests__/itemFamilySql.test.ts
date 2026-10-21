import { describe, expect, it, vi } from "vitest";

// itemMap imports the db client; the SQL builders never touch it.
vi.mock("@/lib/db", () => ({ db: {} }));

import { itemFamilyKey } from "../invoiceLines";
import { CLEAN_NAME_SQL_STEPS, PRODUCT_CODE_SQL_RE } from "../itemMap";

/**
 * HANDOVER-A16 — itemFamilyKeySql() must group lines exactly as itemFamilyKey()
 * does, or gross margin / By SKU count "not linked" families differently from
 * Item mapping. This replays the SQL steps (Postgres \y = JS \b) in JS, the
 * same order and first-vs-every-match choice, and compares on real spellings.
 */
const re = (pattern: string, flags = "") => new RegExp(pattern.replace(/\\y/g, "\\b"), flags);

function familyKeyFromSqlSteps(name: string): string | null {
    const lower = name.toLowerCase();
    const m = lower.match(re(PRODUCT_CODE_SQL_RE));
    if (m) return `code:${m[1]}${m[2].replace(/^0+/, "") || "0"}`;
    let x = lower.split("\n")[0];
    for (const [pattern, replacement, global] of CLEAN_NAME_SQL_STEPS) {
        x = x.replace(re(pattern, global ? "g" : ""), replacement);
    }
    x = x.replace(/^ +| +$/g, "");
    return x ? `name:${x}` : null;
}

// Spellings from invoice_line_items on database-1 / database-2 (14 Oct 2026), plus edge cases.
const FIXTURES = [
    "Wiring Harness SB-75 with 10 Sq. mm(FGCOMFG000002)",
    "Wiring Harness SB-75 with 10 Sq. mm(FGCOMFG00002)",
    "Trontek EV Charger 51V 21A SB50 (1200W)(FGCHMFG00039)",
    "EV Battery Charger 1200W 58V22Amp. SB50",
    "EV Battery Charger 1200W 58V22Amp.SB50, 1year warranty",
    "Trontek Li battery Pack 61V 105Ah CAN 3W ER-69P IN(C-7550) (with IOT) (FG3WMFG00523)Orange Color",
    "Trontek Li battery Pack 61V 105Ah CAN 3W ER-69P IN(C-7550) (with IOT) (FG3WMFG00523)Orange Color\nSerial No.: T2L3E1MWOTDH634604, T2L3E1MWOTDH634605",
    "Trontek Lithium Battery Pack 51v 105Ah",
    "Trontek Li battery pack 51V 105AH",
    "Trontek Li battery Pack 51V 105Ah CAN (EV) ER-59 IN (with IOT)",
    "Trontek Li battery Pack 64V 105Ah Non-IOT",
    "LCD Display with Box V1(FGVMMFG00003)",
    "LCD Display with Box V1 (FGVMMFG003)\r\nSerial No.: X1",
    "Battery Black Colour 2 years warranty, Serial no: ABC",
    "FGABC000",
    "fgabc (no digits) Blue color",
    "Onboarding fee",
    "   ",
    "--",
    "Scrap battery 48V lot_7",
];

describe("itemFamilyKeySql ↔ itemFamilyKey parity", () => {
    it.each(FIXTURES)("%j", (name) => {
        expect(familyKeyFromSqlSteps(name)).toBe(itemFamilyKey(name));
    });
});
