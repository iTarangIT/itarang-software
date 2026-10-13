/**
 * Tracker ID 119 with the ID 166 rule (10 Oct): the full PAN goes only to
 * Admin, the Sales Head, the CEO and the lead's owner; everyone else gets a
 * mask, and a mask sent back by the form never overwrites the stored PAN.
 */
import { describe, expect, it } from "vitest";

import { maskAadhaarDeep } from "../aadhaarMask";
import { isMaskedPan, isPan, maskPan, maskPanDeep, restoreMaskedPan, restoreMaskedPanDeep } from "../panMask";

describe("maskPan", () => {
    it("keeps the last four characters", () => {
        expect(maskPan("ABCDE1234F")).toBe("XXXXXX234F");
        expect(maskPan(" abcde1234f ")).toBe("XXXXXX234F");
        expect(isMaskedPan(maskPan("ABCDE1234F"))).toBe(true);
    });

    it("null and empty stay null; a mask passes through", () => {
        expect(maskPan(null)).toBeNull();
        expect(maskPan(undefined)).toBeNull();
        expect(maskPan("  ")).toBeNull();
        expect(maskPan("XXXXXX234F")).toBe("XXXXXX234F");
    });

    it("never echoes a malformed value whole", () => {
        expect(maskPan("ABCD1234")).toBe("XXXXXX1234");
        expect(maskPan("AB")).toBe("XXXXXXXXXX");
    });

    it("recognises a PAN and only a PAN", () => {
        expect(isPan("ABCDE1234F")).toBe(true);
        expect(isPan("MH12AB1234")).toBe(false); // a vehicle number
        expect(isPan("123412341234")).toBe(false);
        expect(isPan(42)).toBe(false);
    });
});

describe("maskPanDeep", () => {
    it("masks a PAN wherever it sits, whatever the field is called", () => {
        const out = maskPanDeep({
            pan_no: "ABCDE1234F",
            borrowerForm: { pan_no: "PQRST6789Z", full_name: "Asha" },
            ocr: [{ id_number: "LMNOP4321K" }],
            when: new Date("2026-10-12T00:00:00Z"),
            phone: "9876543210",
        });
        expect(out.pan_no).toBe("XXXXXX234F");
        expect(out.borrowerForm).toEqual({ pan_no: "XXXXXX789Z", full_name: "Asha" });
        expect(out.ocr[0].id_number).toBe("XXXXXX321K");
        expect(out.when).toBeInstanceOf(Date);
        expect(out.phone).toBe("9876543210");
    });
});

describe("restoring a masked PAN on save", () => {
    it("keeps the stored PAN when the mask comes back, takes a real edit", () => {
        expect(restoreMaskedPan("XXXXXX234F", "ABCDE1234F")).toBe("ABCDE1234F");
        expect(restoreMaskedPan("ZZZZZ9999Z", "ABCDE1234F")).toBe("ZZZZZ9999Z");
        expect(restoreMaskedPan("XXXXXX234F", undefined)).toBeNull();
    });

    it("works path by path on a whole draft", () => {
        const stored = { borrowerForm: { pan_no: "ABCDE1234F", full_name: "Old" } };
        const incoming = { borrowerForm: { pan_no: "XXXXXX234F", full_name: "New" } };
        expect(restoreMaskedPanDeep(incoming, stored)).toEqual({
            borrowerForm: { pan_no: "ABCDE1234F", full_name: "New" },
        });
    });
});

describe("Aadhaar under an OCR `id_number` field (ID 119)", () => {
    it("is masked; a PAN under the same name is left to maskPanDeep", () => {
        const out = maskAadhaarDeep({ aadhaar: { id_number: "1234 5678 9012" }, pan: { id_number: "ABCDE1234F" } });
        expect(out.aadhaar.id_number).toBe("XXXX XXXX 9012");
        expect(out.pan.id_number).toBe("ABCDE1234F");
    });
});
