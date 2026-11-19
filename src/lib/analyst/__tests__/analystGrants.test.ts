/**
 * IDs 155 / 166 / 169 / 189 — what the AI Analyst's read-only login (analyst_ro) may read.
 *
 * scripts/_create-analyst-readonly-role.mjs runs against a database on import, so its
 * ALLOWED list and withheld() rule are read out of the file text and evaluated here
 * (no database). The schema check walks src/lib/db/schema.ts: every column of a granted
 * table that names a file link, path, file name or attachment must be withheld.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(resolve(__dirname, "../../../../scripts/_create-analyst-readonly-role.mjs"), "utf8");
const from = script.indexOf("const ALLOWED");
const to = script.indexOf("// ID 167 — masked views");
const { ALLOWED, withheld } = new Function(`${script.slice(from, to)}; return { ALLOWED, withheld };`)() as {
    ALLOWED: string[];
    withheld: (table: string, column: string) => boolean;
};

/** table → its column names, from schema.ts (pgTable("name", { col: type("db_name") … })). */
function schemaColumns(): Map<string, string[]> {
    const text = readFileSync(resolve(__dirname, "../../db/schema.ts"), "utf8");
    const out = new Map<string, string[]>();
    for (const part of text.split(/\nexport const /)) {
        const head = /^\w+\s*=\s*pgTable\(\s*["'`]([a-z0-9_]+)["'`]/.exec(part);
        if (!head) continue;
        const body = part.split(/\n\s*\}\s*,\s*\(?|\n\}\);/)[0];
        const cols = [...body.matchAll(/\b[a-zA-Z]+\(\s*["'`]([a-z0-9_]+)["'`]/g)].map((m) => m[1]).filter((c) => c !== head[1]);
        out.set(head[1], cols);
    }
    return out;
}

describe("analyst_ro grants", () => {
    it("ID 155: reads the dated reporting lines, but not their free-text reason", () => {
        expect(ALLOWED).toContain("user_reporting_lines");
        for (const c of ["user_id", "manager_id", "effective_from", "effective_to"]) expect(withheld("user_reporting_lines", c)).toBe(false);
        expect(withheld("user_reporting_lines", "reason")).toBe(true);
        // user id + role come from the analyst_staff view, never from `users` itself.
        expect(ALLOWED).not.toContain("users");
        expect(script).toMatch(/CREATE VIEW public\.analyst_staff AS\s+SELECT u\.id::text AS user_id, u\.name, u\.role, u\.is_active FROM public\.users u/);
    });

    it("ID 169: lost_reason (a fixed code) is readable; the free-text notes are not", () => {
        expect(withheld("dealer_leads", "lost_reason")).toBe(false);
        expect(withheld("dealer_leads", "lost_reason_notes")).toBe(true);
        expect(withheld("dealer_leads", "closed_at")).toBe(false);
        // every other reason column stays withheld
        expect(withheld("account_closures", "reason")).toBe(true);
    });

    it("ID 189: targets and their version history are granted, with the columns the rule names", () => {
        expect(ALLOWED).toEqual(expect.arrayContaining(["sales_targets", "sales_target_versions"]));
        for (const c of ["ceo_target", "admin_addon", "status", "metric", "month", "user_id", "manual_actual"]) {
            expect(withheld("sales_targets", c)).toBe(false);
        }
    });

    it("ID 166: bill, invoice and quote links, paths, file names and attachments are withheld", () => {
        const files: Array<[string, string]> = [
            ["expense_submissions", "bill_url"], ["expense_submissions", "bill_storage_path"], ["expense_submissions", "file_name"],
            ["expense_submissions", "drive_file_id"], ["expense_submissions", "drive_row_ref"],
            ["sales_invoices", "document_url"], ["sales_invoices", "storage_key"], ["sales_invoices", "file_name"],
            ["sales_invoices", "original_filename"], ["sales_invoices", "folder_path"], ["sales_invoices", "drive_file_id"],
            ["credit_notes", "document_url"], ["credit_notes", "file_name"], ["invoices", "pdf_s3"], ["proforma_invoices", "pdf_s3"],
            ["purchase_orders", "pdf_s3"], ["orders", "invoice_url"], ["orders", "pi_url"], ["deals", "invoice_url"],
            ["dealer_lead_commercials", "quote_pdf_url"], ["dealer_lead_commercials", "quote_document_url"],
            ["dealer_lead_commercials", "brochure_url"], ["dealer_lead_commercials", "quote_pdf_error"],
            ["lead_touchpoints", "attachments"], ["service_tickets", "photos_urls"], ["pickups", "eway_bill_s3"],
            ["inventory", "oem_invoice_url"], ["inventory", "warranty_document_url"],
            // 19 Nov: the list campaign filter keeps the uploaded sheet's file name; error text carries paths / rows.
            ["dialer_campaigns", "region_filter"], ["scraper_runs", "error_message"],
        ];
        for (const [t, c] of files) expect(withheld(t, c), `${t}.${c}`).toBe(true);
        // not file links: dates and counts that only contain the words
        expect(withheld("dealer_lead_commercials", "quote_pdf_generated_at")).toBe(false);
        expect(withheld("inventory", "manufacturing_date")).toBe(false);
    });

    it("ID 166: no granted table in schema.ts has a readable file-link / path / file-name / attachment column", () => {
        const FILE = /(^|_)(url|urls|uri|link|links|path|paths|s3|storage_key|filename|file_name|attachments?|document|documents)$|^file_|drive_file/;
        const cols = schemaColumns();
        const leaks: string[] = [];
        for (const t of ALLOWED) for (const c of cols.get(t) ?? []) if (FILE.test(c) && !withheld(t, c)) leaks.push(`${t}.${c}`);
        expect(leaks).toEqual([]);
        // the walk did find the tables it checks
        expect(cols.get("expense_submissions")?.length ?? 0).toBeGreaterThan(5);
    });
});
