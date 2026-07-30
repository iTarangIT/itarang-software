import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { requireSecurityAdmin } from "@/lib/security/route-guard";
import { loadReportData, filtersFromSearchParams } from "@/lib/security/report-data";
import { SEVERITY_LABELS } from "@/lib/security/severity";
import { CATEGORY_LABELS } from "@/lib/security/types";

export const dynamic = "force-dynamic";

type Col = { key: string; label: string; width: number; wrap?: boolean };

const COLUMNS: Col[] = [
  { key: "severity", label: "Severity", width: 12 },
  { key: "category", label: "Category", width: 24 },
  { key: "title", label: "Finding", width: 44, wrap: true },
  { key: "target", label: "Target", width: 40, wrap: true },
  { key: "method", label: "Method", width: 10 },
  { key: "confidence", label: "Confidence", width: 12 },
  { key: "status", label: "Status", width: 14 },
  { key: "owasp", label: "OWASP", width: 12 },
  { key: "cwe", label: "CWE", width: 12 },
  { key: "summary", label: "Summary", width: 60, wrap: true },
  { key: "reproduction", label: "Reproduction", width: 50, wrap: true },
  { key: "remediation", label: "Remediation", width: 50, wrap: true },
  { key: "check", label: "Check", width: 26 },
];

export async function GET(req: NextRequest) {
  const auth = await requireSecurityAdmin();
  if (!auth.ok) return auth.response;

  try {
    const data = await loadReportData(filtersFromSearchParams(req.nextUrl.searchParams));

    const records = data.findings.map((f) => ({
      severity: SEVERITY_LABELS[f.severity],
      category: CATEGORY_LABELS[f.category],
      title: f.title,
      target: f.target_url,
      method: f.http_method || "",
      confidence: f.confidence,
      status: f.status.replace("_", " "),
      owasp: f.owasp_ref || "",
      cwe: f.cwe_ref || "",
      summary: f.summary,
      reproduction: f.reproduction || "",
      remediation: f.remediation || "",
      check: f.check_slug,
    }));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "iTarang";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet("Security Findings", { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.columns = COLUMNS.map((c) => ({ header: c.label, key: c.key, width: c.width }));

    const headerRow = sheet.getRow(1);
    headerRow.height = 28;
    headerRow.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7F1D1D" } };
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border = {
        top: { style: "thin", color: { argb: "FF991B1B" } },
        bottom: { style: "thin", color: { argb: "FF991B1B" } },
        left: { style: "thin", color: { argb: "FF991B1B" } },
        right: { style: "thin", color: { argb: "FF991B1B" } },
      };
    });

    records.forEach((rec, i) => {
      const row = sheet.addRow(rec);
      const zebra = i % 2 === 1;
      row.eachCell((cell, colNumber) => {
        const col = COLUMNS[colNumber - 1];
        cell.alignment = { vertical: "top", horizontal: "left", wrapText: !!col?.wrap };
        if (zebra) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
        cell.border = { bottom: { style: "hair", color: { argb: "FFE2E8F0" } } };
      });
    });

    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };

    const buffer = await workbook.xlsx.writeBuffer();
    const today = new Date().toISOString().slice(0, 10);
    const filename = `security-findings-${today}.xlsx`;
    return new Response(Buffer.from(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": buffer.byteLength.toString(),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("SECURITY REPORT XLSX ERROR:", error);
    return NextResponse.json({ success: false, message: "Failed to export findings" }, { status: 500 });
  }
}
