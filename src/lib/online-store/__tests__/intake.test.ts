import { afterEach, describe, expect, it, vi } from "vitest";
import { financeLeadRemarks, financeLeadSchema, getOnlineStoreKey, verifyStoreKey } from "../intake";

const KEY = "k".repeat(40);

const BODY = {
    storeRef: "FIN-2026-000123",
    name: "Ravi Kumar",
    mobile: "9876543210",
    pincode: "411001",
    productSku: "TK-LiEV-51105",
    productTitle: "LiEV 51V 105Ah",
    productUrl: "https://shop.itarang.com/products/liev-51v-105ah",
    pricePaise: 4_599_900,
    page: "product",
};

describe("online store key (Store R-15)", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("accepts only the exact key", () => {
        expect(verifyStoreKey(KEY, KEY)).toBe(true);
        expect(verifyStoreKey(KEY, ` ${KEY} `)).toBe(true);
        expect(verifyStoreKey(KEY, KEY.slice(1))).toBe(false);
        expect(verifyStoreKey(KEY, `${KEY}x`)).toBe(false);
    });

    it("refuses a missing or empty key, and never matches an unset one", () => {
        expect(verifyStoreKey(KEY, null)).toBe(false);
        expect(verifyStoreKey(KEY, "")).toBe(false);
        expect(verifyStoreKey("", "")).toBe(false);
    });

    it("treats an unset or short ONLINE_STORE_API_KEY as not configured", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.stubEnv("ONLINE_STORE_API_KEY", "");
        expect(getOnlineStoreKey()).toBeNull();
        vi.stubEnv("ONLINE_STORE_API_KEY", "short");
        expect(getOnlineStoreKey()).toBeNull();
        vi.stubEnv("ONLINE_STORE_API_KEY", KEY);
        expect(getOnlineStoreKey()).toBe(KEY);
    });
});

describe("finance enquiry body", () => {
    it("takes the store's contract as sent", () => {
        const r = financeLeadSchema.safeParse(BODY);
        expect(r.success).toBe(true);
        expect(r.data).toMatchObject({ mobile: "9876543210", pincode: "411001", page: "product" });
    });

    it("nulls the optional product fields when absent, null or blank", () => {
        const r = financeLeadSchema.parse({
            ...BODY,
            productSku: null,
            productTitle: "  ",
            productUrl: undefined,
            pricePaise: null,
        });
        expect(r).toMatchObject({ productSku: null, productTitle: null, productUrl: null, pricePaise: null });
    });

    it.each([
        ["mobile with +91", { mobile: "+919876543210" }],
        ["mobile of 9 digits", { mobile: "987654321" }],
        ["mobile starting 5", { mobile: "5876543210" }],
        ["pincode of 5 digits", { pincode: "41100" }],
        ["pincode starting 0", { pincode: "011001" }],
        ["unknown page", { page: "cart" }],
        ["blank name", { name: "  " }],
        ["missing storeRef", { storeRef: undefined }],
        ["fractional price", { pricePaise: 12.5 }],
        ["negative price", { pricePaise: -1 }],
    ])("refuses %s", (_label, patch) => {
        expect(financeLeadSchema.safeParse({ ...BODY, ...patch }).success).toBe(false);
    });
});

describe("lead remark", () => {
    it("says where, what, the pincode and the store ref", () => {
        const text = financeLeadRemarks(financeLeadSchema.parse(BODY));
        expect(text).toContain("Buy on finance (product page)");
        expect(text).toContain("LiEV 51V 105Ah (SKU TK-LiEV-51105) ₹45,999");
        expect(text).toContain("Pincode 411001.");
        expect(text).toContain("Store ref FIN-2026-000123.");
    });

    it("leaves out the product line when the store sent none", () => {
        const text = financeLeadRemarks(
            financeLeadSchema.parse({ ...BODY, page: "checkout", productSku: null, productTitle: null, productUrl: null, pricePaise: null }),
        );
        expect(text).toBe("Online store — Buy on finance (checkout). Pincode 411001. Store ref FIN-2026-000123.");
    });
});
