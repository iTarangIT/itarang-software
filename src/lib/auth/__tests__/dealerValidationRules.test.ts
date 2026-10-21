import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// _lib.ts imports the database, so its list is read from the source.
const ACCOUNTS_LIB = readFileSync(join(process.cwd(), "src", "app", "api", "admin", "accounts", "_lib.ts"), "utf8");
const ASSIGNABLE_OWNER_ROLES = [
    ...(/ASSIGNABLE_OWNER_ROLES\s*=\s*\[([^\]]*)\]/.exec(ACCOUNTS_LIB)?.[1] ?? "").matchAll(/"([a-z_]+)"/g),
].map((m) => m[1]);

import {
    DEALER_VALIDATION_ALL_ROLES,
    DEALER_VALIDATION_OWNER_ROLES,
    DEALER_VALIDATION_PAGE_ROLES,
    dealerValidationScope,
    mayReadDealerApplication,
    ownsDealerApplication,
} from "../dealerValidationRules";

describe("Dealer Validation readers (ID 166 item 11, 18 Oct)", () => {
    it("Sales Head, CEO and now Admin read every application", () => {
        expect([...DEALER_VALIDATION_ALL_ROLES].sort()).toEqual(["admin", "ceo", "sales_head"]);
        for (const role of DEALER_VALIDATION_ALL_ROLES) {
            expect(dealerValidationScope(role)).toBe("all");
            expect(mayReadDealerApplication({ role, userId: "u-1" })).toBe(true);
        }
    });

    it("an account-owner role reads only the applications it owns", () => {
        for (const role of DEALER_VALIDATION_OWNER_ROLES) {
            expect(dealerValidationScope(role)).toBe("own");
            expect(mayReadDealerApplication({ role, userId: "u-1" })).toBe(false);
            expect(mayReadDealerApplication({ role, userId: "u-1", accountOwnerId: "u-1" })).toBe(true);
            expect(mayReadDealerApplication({ role, userId: "u-1", salespersonUserId: "u-1" })).toBe(true);
            expect(mayReadDealerApplication({ role, userId: "u-1", ownerId: "u-1" })).toBe(true);
            expect(mayReadDealerApplication({ role, userId: "u-1", accountOwnerId: "u-2", ownerId: "u-3" })).toBe(false);
        }
    });

    it("the owner roles are every role an account can be owned by (sales_head reads all anyway)", () => {
        expect([...DEALER_VALIDATION_OWNER_ROLES].sort()).toEqual(
            ASSIGNABLE_OWNER_ROLES.filter((r) => r !== "sales_head").sort(),
        );
    });

    it("dealers, NBFCs and unknown roles never read the page", () => {
        for (const role of ["dealer", "nbfc_partner", "user", "", null, "partner", "finance_controller"]) {
            expect(dealerValidationScope(role)).toBe("none");
            expect(mayReadDealerApplication({ role, userId: "u-1", accountOwnerId: "u-1" })).toBe(false);
            expect(DEALER_VALIDATION_PAGE_ROLES as readonly (string | null)[]).not.toContain(role);
        }
    });

    it("ownsDealerApplication never matches a missing id", () => {
        expect(ownsDealerApplication("", { accountOwnerId: "" })).toBe(false);
        expect(ownsDealerApplication(null, { accountOwnerId: null, salespersonUserId: null, ownerId: null })).toBe(false);
    });
});
