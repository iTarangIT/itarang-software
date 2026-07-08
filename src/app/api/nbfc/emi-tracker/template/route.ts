/**
 * GET /api/nbfc/emi-tracker/template
 *
 * Streams the EMI Tracker bulk-upload template as a .xlsx. Column set mirrors the
 * operator's real "EMI Collection Tech.xlsx" so an existing sheet uploads unedited.
 * Date columns are locked to Text (numFmt "@") so Excel doesn't silently re-coerce
 * dd/mm/yyyy into serials. A second "Instructions" sheet documents the required
 * columns + date format. Tenant-scoped (NBFC access only).
 */
import ExcelJS from "exceljs";

import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";
import { clientError } from "@/lib/nbfc/http-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Full column set (mirrors the source sheet). The 7 collect pairs use distinct
// date names for clarity; the parser also accepts the legacy duplicated
// "EMI Collect Date" headers positionally.
function buildHeaders(): string[] {
  const base = [
    "Dealer Name",
    "Location",
    "Delar Mobile No",
    "Driver Name",
    "GEO (Lat, Long)",
    "Financer",
    "Driver Address",
    "Driver Mobile No",
    "Battery No",
    "Total Loan Amount",
    "Total EMI Amount",
    "Tenure",
    "Battery Installation Date",
  ];
  const collect: string[] = [];
  const ord = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th"];
  for (let i = 0; i < 7; i++) {
    collect.push(`${ord[i]} Amount Collected`, `EMI ${i + 1} Collect Date`);
  }
  return [...base, ...collect, "EMI Due Date"];
}

/** 0-based indices of every date column (locked to Text). */
function dateColumnIndexes(headers: string[]): number[] {
  return headers
    .map((h, i) => (/date/i.test(h) ? i : -1))
    .filter((i) => i >= 0);
}

const SAMPLE_ROWS: (string | number)[][] = [
  [
    "M S Enterprises",
    "Aligarh, Uttar Pradesh",
    "8273998582",
    "Sami Ur Rehman",
    "27.908563, 78.092025",
    "iTarang Finance",
    "Raza Nagar, Koil, Aligarh, UP 202001",
    "6395993844",
    "TK-51105-07KY-161951",
    63000,
    5250,
    15,
    "26/11/2025",
    5250,
    "30/12/2025",
    5250,
    "30/01/2026",
    5250,
    "28/02/2026",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "26/07/2026",
  ],
];

export async function GET() {
  try {
    const tenant = await getCurrentTenant();
    await requireNbfcAccess(tenant.id);

    const headers = buildHeaders();
    const dateIdx = new Set(dateColumnIndexes(headers));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "iTarang";

    const sheet = workbook.addWorksheet("EMI Data", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    sheet.columns = headers.map((h) => ({
      header: h,
      key: h,
      width: Math.max(14, h.length + 2),
    }));

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE6F0F7" } };

    // Lock date columns to Text so Excel preserves dd/mm/yyyy exactly.
    for (const idx of dateIdx) sheet.getColumn(idx + 1).numFmt = "@";

    for (const row of SAMPLE_ROWS) {
      const obj: Record<string, string | number> = {};
      headers.forEach((h, i) => {
        obj[h] = row[i] ?? "";
      });
      const added = sheet.addRow(obj);
      for (const idx of dateIdx) added.getCell(idx + 1).numFmt = "@";
    }

    // Instructions sheet.
    const info = workbook.addWorksheet("Instructions");
    info.columns = [{ width: 4 }, { width: 100 }];
    const lines: string[] = [
      "EMI Tracker — Bulk Upload Template",
      "",
      "How it works:",
      "• Each row updates ONE loan already on the EMI Tracker. Rows are matched by Battery No.",
      "• If a Battery No isn't found on the tracker, that row is reported as an error and skipped.",
      "• Drivers already carrying tracker data are flagged as duplicates and skipped unless you tick 'overwrite'.",
      "",
      "Required columns:",
      "• Battery No — the match key. Must exactly match a battery serial on the tracker.",
      "• Total EMI Amount — the EMI shown per loan.",
      "• Tenure — total number of EMIs (drives the progress denominator).",
      "• EMI Due Date — the next payment date (used to derive Status + DPD).",
      "",
      "Collections:",
      "• Fill '1st Amount Collected' … '7th Amount Collected' with the amount for each paid EMI.",
      "• Put the matching payment date in the 'EMI N Collect Date' column beside each amount.",
      "• Leave a slot blank if that EMI hasn't been collected. Paid count = number of filled amounts.",
      "",
      "Dates:",
      "• Use DD/MM/YYYY (e.g. 26/07/2026). Impossible dates like 30/02/2026 are rejected.",
      "• Date columns are pre-formatted as Text so Excel won't change what you type.",
      "",
      "Note: Dealer/Location/GEO/Address columns are accepted but not shown on the tracker.",
    ];
    lines.forEach((t, i) => {
      const cell = info.getCell(`B${i + 1}`);
      cell.value = t;
      if (i === 0) cell.font = { bold: true, size: 14 };
      else if (t.endsWith(":")) cell.font = { bold: true };
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="emi-tracker-template.xlsx"',
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.includes("FORBIDDEN") || msg.includes("not allowed")
      ? 403
      : msg.startsWith("UNAUTHORIZED")
        ? 401
        : 500;
    return new Response(JSON.stringify({ ok: false, error: clientError(msg) }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
