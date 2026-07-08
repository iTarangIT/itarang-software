/**
 * Ad-hoc verification for the EMI Tracker bulk-upload parser (no DB).
 *   tsx scripts/_verify-emi-bulk.ts
 * Proves: positional column resolution, Excel-serial + dd/mm/yyyy dates,
 * 30-Feb rejection, derived status/DPD/progress.
 */
import xlsx from "xlsx";
import { parseEmiUploadRows } from "@/lib/nbfc/emi-tracker/bulkUpload";

const XLSX_PATH = "C:/Users/Aniket/Downloads/EMI Collection Tech.xlsx";
const TODAY = new Date(Date.UTC(2026, 6, 7)); // 2026-07-07

const wb = xlsx.readFile(XLSX_PATH);
const ws = wb.Sheets[wb.SheetNames[0]];
const matrix = xlsx.utils.sheet_to_json<unknown[]>(ws, {
  header: 1,
  raw: true,
  defval: null,
  blankrows: false,
});
const header = matrix[0];
const rows = matrix.slice(1);

// Inject a deliberately-broken date (30 Feb) into row 1's EMI Due Date (last col)
// to prove impossible dates are caught.
if (rows[0]) {
  const broken = [...(rows[0] as unknown[])];
  broken[broken.length - 1] = "30/02/2026";
  rows.splice(1, 0, broken); // insert as a second row
}

const parsed = parseEmiUploadRows(header, rows, { today: TODAY });

console.log(`Header cols: ${header.length}`);
console.log(`Parsed ${parsed.length} row(s):\n`);
for (const r of parsed) {
  console.log(
    `row ${r.rowNumber} | ${r.borrower ?? "—"} | battery=${r.batteryNo ?? "—"} | ` +
      `emi=${r.derived.emi} | prog=${r.derived.progress_paid}/${r.derived.progress_total} | ` +
      `lastPaid=${r.derived.last_paid} | nextDue=${r.derived.next_due} | ` +
      `status=${r.derived.status} | dpd=${r.derived.dpd} | financier=${r.derived.financier}`,
  );
  for (const iss of r.issues) {
    console.log(`     ⚠ ${iss.column}: ${iss.message}`);
  }
}
