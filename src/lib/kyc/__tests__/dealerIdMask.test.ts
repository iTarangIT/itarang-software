/**
 * Tracker ID 119 point 3 (decided 21 Oct, same rule as customer KYC): a dealer
 * owner's Aadhaar is masked for everyone; PAN and bank account number are full
 * only for Admin, the CEO and the Sales Head.
 */
import { describe, expect, it } from "vitest";

import {
    isMaskedBankAccount,
    maskBankAccount,
    maskCapturedIds,
    maskDealerIdsDeep,
    seesFullDealerIds,
} from "../dealerIdMask";

describe("seesFullDealerIds", () => {
    it("Admin, CEO and Sales Head only", () => {
        for (const r of ["admin", "ceo", "sales_head"]) expect(seesFullDealerIds(r), r).toBe(true);
        for (const r of ["partner", "business_head", "sales_manager", "dealer", "", null, undefined]) {
            expect(seesFullDealerIds(r), String(r)).toBe(false);
        }
    });
});

describe("maskBankAccount", () => {
    it("keeps the last four digits; null/empty stay null; a mask passes through", () => {
        expect(maskBankAccount("50100123456789")).toBe("XXXXXX6789");
        expect(maskBankAccount(" 5010 0123 4567 89 ")).toBe("XXXXXX6789");
        expect(maskBankAccount("123")).toBe("XXXXXX");
        expect(maskBankAccount(null)).toBeNull();
        expect(maskBankAccount("")).toBeNull();
        expect(maskBankAccount("XXXXXX6789")).toBe("XXXXXX6789");
        expect(isMaskedBankAccount("XXXXXX6789")).toBe(true);
        expect(isMaskedBankAccount("50100123456789")).toBe(false);
    });
});

const extracted = {
    pan: "ABCDE1234F",
    aadhaar_number: "1234 5678 9012",
    account_number: "50100123456789",
    ifsc: "HDFC0001234",
    nested: [{ ownerAadhaar: "123456789012", bank_account_no: 50100123456789 }],
};

describe("maskDealerIdsDeep", () => {
    it("full-ID roles: Aadhaar masked, PAN and account kept", () => {
        const out = maskDealerIdsDeep(extracted, true);
        expect(out.aadhaar_number).toBe("XXXX XXXX 9012");
        expect(out.nested[0].ownerAadhaar).toBe("XXXX XXXX 9012");
        expect(out.pan).toBe("ABCDE1234F");
        expect(out.account_number).toBe("50100123456789");
        expect(out.nested[0].bank_account_no).toBe(50100123456789);
    });

    it("other roles: all three masked, other fields untouched", () => {
        const out = maskDealerIdsDeep(extracted, false);
        expect(out.aadhaar_number).toBe("XXXX XXXX 9012");
        expect(out.pan).toBe("XXXXXX234F");
        expect(out.account_number).toBe("XXXXXX6789");
        expect(out.nested[0].bank_account_no).toBe("XXXXXX6789");
        expect(out.ifsc).toBe("HDFC0001234");
    });

    it("does not change its input", () => {
        maskDealerIdsDeep(extracted, false);
        expect(extracted.pan).toBe("ABCDE1234F");
    });
});

describe("maskCapturedIds", () => {
    const fields = [
        { key: "panNumber", label: "Company PAN", value: "ABCDE1234F" },
        { key: "ownerAadhaar", label: "Owner Aadhaar", value: "123456789012" },
        { key: "accountNumber", label: "Account number", value: "50100123456789" },
        { key: "pan", label: "Pan", value: "ABCDE1234F" },
        { key: "companyName", label: "Business name", value: "Acme Motors" },
    ];

    it("full-ID roles: only Aadhaar masked", () => {
        expect(maskCapturedIds(fields, true).map((f) => f.value)).toEqual([
            "ABCDE1234F", "XXXX XXXX 9012", "50100123456789", "ABCDE1234F", "Acme Motors",
        ]);
    });

    it("other roles (partner login): Aadhaar, PAN and account masked", () => {
        expect(maskCapturedIds(fields, false).map((f) => f.value)).toEqual([
            "XXXXXX234F", "XXXX XXXX 9012", "XXXXXX6789", "XXXXXX234F", "Acme Motors",
        ]);
    });
});
