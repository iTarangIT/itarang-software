import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ACCOUNT_OWNER_READ_ROLES, kycLeadScope, mayReadAsAccountOwner } from "../leadAccessRules";

const ROOT = path.resolve(__dirname, "../../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

describe("ID 166: the dealer account's owner reads its customers' KYC tabs", () => {
    it("an ISR or ASM who owns the account reads; anyone else does not", () => {
        expect([...ACCOUNT_OWNER_READ_ROLES]).toEqual(["inside_sales_rep", "asm"]);
        expect(mayReadAsAccountOwner({ role: "asm", userId: "u1", accountOwnerId: "u1" })).toBe(true);
        expect(mayReadAsAccountOwner({ role: "inside_sales_rep", userId: "u1", accountOwnerId: "u1" })).toBe(true);
        expect(mayReadAsAccountOwner({ role: "asm", userId: "u1", accountOwnerId: "u2" })).toBe(false);
        expect(mayReadAsAccountOwner({ role: "asm", userId: "u1", accountOwnerId: null })).toBe(false);
        expect(mayReadAsAccountOwner({ role: "asm", userId: "", accountOwnerId: "" })).toBe(false);
        expect(mayReadAsAccountOwner({ role: "dealer", userId: "u1", accountOwnerId: "u1" })).toBe(false);
        expect(mayReadAsAccountOwner({ role: "partner", userId: "u1", accountOwnerId: "u1" })).toBe(false);
    });

    it("does not widen the KYC review lists (they stay back-office only)", () => {
        expect(kycLeadScope("asm")).toBe("none");
        expect(kycLeadScope("inside_sales_rep")).toBe("none");
    });

    it("only the three read-only lists pass `read: true`; no route that changes a file does", () => {
        const readers = [
            "src/app/api/kyc/[leadId]/documents/route.ts",
            "src/app/api/coborrower/[leadId]/documents/route.ts",
            "src/app/api/kyc/[leadId]/requested-docs/route.ts",
        ];
        for (const f of readers) expect(read(f)).toContain("{ read: true }");

        // requested-docs: the GET passes it, the POST (create a request) does not.
        const requested = read("src/app/api/kyc/[leadId]/requested-docs/route.ts");
        const post = requested.slice(requested.indexOf("export async function POST"));
        expect(post).not.toContain("read: true");

        for (const f of [
            "src/app/api/kyc/[leadId]/upload-document/route.ts",
            "src/app/api/coborrower/[leadId]/upload-document/route.ts",
            "src/app/api/kyc/[leadId]/submit-for-verification/route.ts",
            "src/app/api/kyc/[leadId]/requested-docs/create/route.ts",
        ]) {
            expect(read(f)).not.toContain("read: true");
        }
    });
});
