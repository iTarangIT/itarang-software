/**
 * Tracker IDs 173 and 174 — stock upload follow-ups. Source-text contract
 * (the routes and the sidebar import the database / React).
 *
 *   173.2 the older bulk upload takes the model from the Product Master by model id
 *   173.3 a dealer has a menu link to the older upload page
 *   173.4 the Transfer form shows only when the API would accept the role
 *   173.5 the Inventory download carries 'Uploaded by' and the upload batch
 *   174.2 "not a dealer sale" closes the task and is never escalated
 *   174.3 Admin's own menu has "Stock to upload"
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const code = (rel: string) =>
    readFileSync(join(SRC, ...rel.split("/")), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

/** One role's block of roleNavigation in the sidebar: from `  role: [` to the next top-level role key. */
function sidebarRole(role: string): string {
    const s = code("components/layout/sidebar.tsx");
    const start = s.indexOf(`\n  ${role}: [`);
    expect(start, `sidebar role ${role}`).toBeGreaterThan(-1);
    const rest = s.slice(start + 1);
    const next = rest.slice(1).search(/\n  [a-z_"]+: \[/);
    return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("ID 173 item 2 — older bulk upload resolves the model from the Product Master", () => {
    const route = code("app/api/inventory/bulk-upload/route.ts");
    it("loads the Product Master by the template's model id column", () => {
        expect(route).toMatch(/loadProductMasterBatch\(/);
        expect(route).toMatch(/legacyMasterKeyOf\(assetType, r\)/);
        expect(route).toMatch(/resolveLegacyUploadModel\(/);
    });
    it("no longer derives the model straight from the old column", () => {
        expect(route).not.toMatch(/clean\(r\.model_number\)\s*\|\|\s*"Battery"/);
        expect(route).toMatch(/model_type: modelType/);
    });
});

describe("ID 173 item 3 — dealer menu link to the older upload page", () => {
    it("the dealer menu links /inventory/bulk-upload", () => {
        expect(sidebarRole("dealer")).toMatch(/href: "\/inventory\/bulk-upload"/);
    });
});

describe("ID 173 item 4 — Transfer form follows the API rule", () => {
    it("GET reports canTransfer from the same rule POST enforces", () => {
        const r = code("app/api/admin/inventory/transfer/route.ts");
        expect(r).toMatch(/canSubmitStockTransfer\(viewer\.role\)/);
        expect(r).toMatch(/rows, canTransfer/);
        expect(r).toMatch(/requireStockTransferer\(/);
    });
    it("the page renders the form only when canTransfer is true", () => {
        const p = code("app/(dashboard)/admin/inventory/transfer/page.tsx");
        expect(p).toMatch(/\{canTransfer === true && \(\s*<section/);
        expect(p).toMatch(/setCanTransfer\(tr\.data\?\.canTransfer === true\)/);
    });
});

describe("ID 173 item 5 — Inventory download has Uploaded by and upload batch", () => {
    const r = code("app/api/admin/inventory/all/route.ts");
    it("selects the uploader and the batch", () => {
        expect(r).toMatch(/uploadedBy: sql<string \| null>`COALESCE\(\$\{users\.name\}, \$\{users\.email\}\)`/);
        expect(r).toMatch(/uploadBatch: inventory\.upload_event_id/);
        expect(r).toMatch(/leftJoin\(users, eq\(users\.id, inventory\.created_by\)\)/);
    });
    it("writes both columns to the CSV", () => {
        expect(r).toMatch(/"uploadedBy",\s*"uploadBatch",\s*\]/);
        expect(r).toMatch(/row\.uploadedBy,\s*row\.uploadBatch,/);
    });
});

describe("ID 173 (23 Oct) — the plain stock list and the Data downloads Inventory list", () => {
    it("GET /api/inventory is scoped by role (back office + CEO all, a dealer its own)", () => {
        const r = code("app/api/inventory/route.ts");
        expect(r).toMatch(/inventoryListScope\(user\.role\)/);
        expect(r).toMatch(/scope === 'none'\) return errorResponse\([^)]*403\)/);
        expect(r).toMatch(/filters\.push\(eq\(inventory\.dealer_id, own\)\)/);
    });
    it("the Data downloads Inventory list has Uploaded by and the batch", () => {
        const r = code("lib/exports/datasets/registry.ts");
        expect(r).toMatch(/COALESCE\(u\.name, u\.email\) AS uploaded_by, i\.upload_event_id AS upload_batch/);
        expect(r).toMatch(/LEFT JOIN users u ON u\.id = i\.created_by/);
    });
});

describe("ID 174 item 2 — not a dealer sale closes the task", () => {
    it("the Invoice Ledger action closes the task", () => {
        const r = code("app/api/dashboard/ceo/invoices/[id]/link/route.ts");
        expect(r).toMatch(/closeTasksForNotDealerSale\(\{ source, invoiceId: id, userId: user\.id, note \}\)/);
    });
    it("the recheck closes such tasks and the escalation skips them", () => {
        const s = code("lib/inventory/stockUploadTasks/service.ts");
        expect(s).toMatch(/closed_how = 'not_dealer'/);
        expect(s).toMatch(/const notDealer = await notDealerTasks\(tasks\)/);
        const sweep = s.slice(s.indexOf("export async function sweepStockTasks"));
        expect(sweep).toMatch(/NOT EXISTS \(SELECT 1 FROM invoice_account_links lk[\s\S]*lk\.kind = 'not_dealer'\)/);
        expect(sweep).toMatch(/\$\{notDealer\}/);
    });
});

describe("ID 174 item 3 — Admin menu has Stock to upload", () => {
    it("the admin menu links /admin/inventory/stock-tasks", () => {
        expect(sidebarRole("admin")).toMatch(/href: "\/admin\/inventory\/stock-tasks"/);
    });
});
