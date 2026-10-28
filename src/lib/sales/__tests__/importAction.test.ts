import { describe, expect, it } from "vitest";

import { importActionFor } from "../importAction";

describe("importActionFor (ID 200 #4: no double counting with Zoho)", () => {
    it("skips a register invoice whose number is already a Zoho invoice", () => {
        expect(importActionFor("vyapar_register", null, true)).toBe("in_zoho");
    });
    it("creates a new register-only invoice", () => {
        expect(importActionFor("vyapar_register", null, false)).toBe("create");
    });
    it("updates an invoice already in the CRM, even if Zoho has the number", () => {
        expect(importActionFor("vyapar_register", "si-1", true)).toBe("update");
    });
    it("a GSTR-1 file only records the filed rows", () => {
        expect(importActionFor("gstr1", null, true)).toBe("gstr1");
    });
});
