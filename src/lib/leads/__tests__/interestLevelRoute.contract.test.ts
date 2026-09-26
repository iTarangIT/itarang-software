import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// BRD §2.3-3: the interest-level route was the only dealer_lead mutate route
// without an ownership check. It must assert ownership BEFORE it writes, and a
// refusal must be a 403 (ForbiddenLeadAccessError has no .status, so an
// unmapped throw would surface as a 500).

const ROUTE = join(process.cwd(), "src", "app", "api", "inside-sales", "lead", "[id]", "interest-level", "route.ts");
const code = () =>
    readFileSync(ROUTE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("interest-level route (contract)", () => {
    it("asserts ownership before setting the level", () => {
        const c = code();
        const owner = c.indexOf("await assertOwner(id, user.id)");
        const write = c.indexOf("await setInterestLevel(");
        expect(owner).toBeGreaterThan(-1);
        expect(write).toBeGreaterThan(owner);
    });

    it("maps a non-owner to 403", () => {
        expect(code()).toMatch(/instanceof ForbiddenLeadAccessError\)\s*\{\s*return errorResponse\([^)]*,\s*403\)/);
    });
});
