// ID 200 #7 — a one-time list for Finance of every old Zoho invoice still
// counted in Accounts Receivable. Zoho invoices cannot be cleared in the CRM
// (their balance comes from Zoho), so Finance confirms each one paid or void.
// Read-only: the same rows the /ceo/receivables page lists (listReceivables).
//
//   node --import tsx --env-file=.env.local      scripts/export-zoho-still-owed.ts
//   node --import tsx --env-file=.env.production scripts/export-zoho-still-owed.ts
//
// Writes reports/zoho-still-owed-<db>-<date>.xlsx.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import ExcelJS from "exceljs";

import { listReceivables } from "@/lib/dashboard/receivables";

async function main() {
    const host = new URL(process.env.DATABASE_URL ?? "postgres://unset").host;
    console.log(`DB host: ${host}`);
    const rows = (await listReceivables()).filter((r) => r.source === "zoho" && r.balance > 0);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Zoho invoices still owed");
    ws.columns = [
        { header: "Invoice number", key: "number", width: 22 },
        { header: "Invoice date", key: "date", width: 13 },
        { header: "Due date", key: "due", width: 13 },
        { header: "Customer on invoice", key: "customer", width: 34 },
        { header: "Matched dealer", key: "dealer", width: 34 },
        { header: "Owner", key: "owner", width: 20 },
        { header: "Invoice total (₹)", key: "total", width: 16 },
        { header: "Still counted as owed (₹)", key: "balance", width: 20 },
        { header: "Age (days)", key: "age", width: 11 },
        { header: "Zoho status", key: "status", width: 14 },
        { header: "Finance: paid / void / still owed", key: "finance", width: 30 },
        { header: "Finance note", key: "note", width: 30 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows.sort((a, b) => (a.invoice_date ?? "").localeCompare(b.invoice_date ?? ""))) {
        ws.addRow({
            number: r.invoice_number,
            date: r.invoice_date?.slice(0, 10) ?? "",
            due: r.due_date?.slice(0, 10) ?? "",
            customer: r.customer_name,
            dealer: r.dealer_name ?? "Not linked",
            owner: r.owner_name ?? "",
            total: r.total,
            balance: r.balance,
            age: r.age_days,
            status: r.status ?? "",
            finance: "",
            note: "",
        });
    }
    const sum = rows.reduce((a, r) => a + r.balance, 0);
    ws.addRow({});
    ws.addRow({ number: `Total (${rows.length})`, balance: sum }).font = { bold: true };

    const dir = join(process.cwd(), "reports");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `zoho-still-owed-${host.split(".")[0]}-${new Date().toISOString().slice(0, 10)}.xlsx`);
    await wb.xlsx.writeFile(file);
    console.log(`${rows.length} Zoho invoices still counted, ₹${Math.round(sum).toLocaleString("en-IN")} → ${file}`);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
