/**
 * HANDOVER-A6 (23 Oct) — the "Claimed outside territory" card: a full list
 * behind it, the Admin dashboard's own filters, and a note that it checks
 * against today's territories. Source-text contract: the card is a client
 * component and its API imports the database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const code = (rel: string) =>
    readFileSync(join(SRC, ...rel.split("/")), "utf8")
        .replace(/\r\n/g, "\n")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

describe("HANDOVER-A6: Claimed outside territory card", () => {
    const card = code("components/leads/OutsideTerritoryClaims.tsx");

    it("'See all' opens the click-to-list popup (with CSV) instead of '+ n more'", () => {
        expect(card).not.toMatch(/\+ \{d\.counts\.outside - SHOWN\} more/);
        expect(card).toMatch(/<SalesDrillModal target=\{drill\}/);
        expect(card).toMatch(/csvName: csv/);
    });

    it("says it checks against today's territories", () => {
        expect(card).toMatch(/Checked against today&apos;s territories/);
    });

    it("the Admin dashboard passes its filters", () => {
        const view = code("app/(dashboard)/admin/_components/AdminDashboardView.tsx");
        expect(view).toMatch(/<OutsideTerritoryClaims\s+filters=\{\{[\s\S]*from: filters\.date_from[\s\S]*spoc_id: filters\.owner_id/);
    });

    it("the API returns enough rows for the full list", () => {
        expect(code("app/api/admin/claims/outside-territory/route.ts")).toMatch(/const MAX_ROWS = 2000;/);
    });
});
