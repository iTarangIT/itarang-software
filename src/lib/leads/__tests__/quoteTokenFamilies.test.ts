import { beforeAll, describe, expect, it } from "vitest";

import {
    accountQuoteApprovalUrl,
    mintAccountQuoteToken,
    mintQuoteToken,
    readAccountQuoteToken,
    readQuoteToken,
} from "@/lib/leads/quoteToken";

const ID = "11111111-2222-3333-4444-555555555555";

beforeAll(() => {
    process.env.QUOTE_TOKEN_SECRET = "test-secret-for-token-families";
});

describe("lead and account quotation tokens never cross (E-356)", () => {
    it("each family reads its own token", () => {
        expect(readQuoteToken(mintQuoteToken({ commercialId: ID, versionNo: 2 }))).toEqual({
            commercialId: ID,
            versionNo: 2,
        });
        expect(readAccountQuoteToken(mintAccountQuoteToken({ quotationId: ID, versionNo: 3 }))).toEqual({
            quotationId: ID,
            versionNo: 3,
        });
    });

    it("a lead token does not open an account quotation", () => {
        expect(readAccountQuoteToken(mintQuoteToken({ commercialId: ID, versionNo: 1 }))).toBeNull();
    });

    it("an account token does not open a lead quotation", () => {
        expect(readQuoteToken(mintAccountQuoteToken({ quotationId: ID, versionNo: 1 }))).toBeNull();
    });

    it("a tampered account token is refused", () => {
        const t = mintAccountQuoteToken({ quotationId: ID, versionNo: 1 });
        expect(readAccountQuoteToken(t.slice(0, -1) + (t.endsWith("a") ? "b" : "a"))).toBeNull();
    });

    it("the account link opens /quote/a/", () => {
        expect(accountQuoteApprovalUrl({ quotationId: ID, versionNo: 1 })).toMatch(/\/quote\/a\/[^/]+$/);
    });
});
