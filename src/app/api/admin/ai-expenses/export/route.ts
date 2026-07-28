/**
 * E-172 — GET /api/admin/ai-expenses/export?month=YYYY-MM
 *
 * Admin-only. Streams a ZIP for the selected month containing:
 *   - expenses_{month}.xlsx   — one styled row per AI expense
 *   - invoices/               — each expense's stored bill (PDF/image)
 *
 * Bills are pulled from Supabase Storage (by stored path, with a public-URL
 * fetch fallback); a bill that can't be fetched is skipped with a warning row
 * rather than aborting the export. An empty month still returns a valid ZIP
 * with the headered (empty) sheet plus a README.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { db } from "@/lib/db";
import { expenseSubmissions, users } from "@/lib/db/schema";
import { requireApiAdmin } from "@/lib/auth/requireApiAdmin";
import { isNextRedirectError, errorMessage } from "@/lib/api-utils";
import { createClient } from "@/lib/supabase/server";
import { extOf, safeSlug, fetchAsBuffer } from "@/lib/export/zip-helpers";
import { expenseBucketLabel, expenseDepartmentLabel } from "@/lib/expenses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_ROWS = 500;

export async function GET(req: NextRequest) {
  try {
    const guard = await requireApiAdmin();
    if (!guard.ok) return guard.response;

    const month = req.nextUrl.searchParams.get("month") || "";
    const m = month.match(/^(\d{4})-(\d{2})$/);
    if (!m) {
      return NextResponse.json(
        { success: false, error: { message: "month must be YYYY-MM" } },
        { status: 400 },
      );
    }
    const year = Number(m[1]);
    const mon = Number(m[2]); // 1-indexed
    if (mon < 1 || mon > 12) {
      return NextResponse.json(
        { success: false, error: { message: "invalid month" } },
        { status: 400 },
      );
    }
    // Build [start, end) as local date strings (mirror the CEO route — never
    // toISOString() a local midnight).
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const startStr = `${year}-${pad2(mon)}-01`;
    const endYear = mon === 12 ? year + 1 : year;
    const endMon = mon === 12 ? 1 : mon + 1;
    const endStr = `${endYear}-${pad2(endMon)}-01`;

    // COALESCE(expense_date, created_at::date) is the effective expense day.
    const effectiveDate = sql`COALESCE(${expenseSubmissions.expense_date}, ${expenseSubmissions.created_at}::date)`;

    const rows = await db
      .select({
        id: expenseSubmissions.id,
        invoice_number: expenseSubmissions.invoice_number,
        file_name: expenseSubmissions.file_name,
        vendor: expenseSubmissions.vendor,
        amount: expenseSubmissions.amount,
        department: expenseSubmissions.department,
        bucket: expenseSubmissions.bucket,
        project_tag: expenseSubmissions.project_tag,
        description: expenseSubmissions.description,
        expense_date: expenseSubmissions.expense_date,
        created_at: expenseSubmissions.created_at,
        bill_url: expenseSubmissions.bill_url,
        bill_storage_path: expenseSubmissions.bill_storage_path,
        ai_raw: expenseSubmissions.ai_raw,
        submitter_name: users.name,
      })
      .from(expenseSubmissions)
      .leftJoin(users, eq(expenseSubmissions.submitted_by, users.id))
      .where(
        and(
          eq(expenseSubmissions.source, "ai"),
          gte(effectiveDate, startStr),
          lt(effectiveDate, endStr),
        ),
      )
      .orderBy(desc(effectiveDate))
      .limit(MAX_ROWS + 1);

    const capped = rows.length > MAX_ROWS;
    const data = capped ? rows.slice(0, MAX_ROWS) : rows;

    // ---- Build the Excel workbook ----
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`Expenses ${month}`);
    ws.columns = [
      { header: "Invoice #", key: "invoice_number", width: 20 },
      { header: "Date", key: "date", width: 14 },
      { header: "Vendor", key: "vendor", width: 28 },
      { header: "Amount", key: "amount", width: 14 },
      { header: "Currency", key: "currency", width: 10 },
      { header: "Bucket", key: "bucket", width: 16 },
      { header: "Department", key: "department", width: 16 },
      { header: "Project Tag", key: "project_tag", width: 18 },
      { header: "Description", key: "description", width: 40 },
      { header: "File name", key: "file_name", width: 28 },
      { header: "Submitted by", key: "submitter", width: 20 },
      { header: "Recorded at", key: "recorded_at", width: 20 },
      { header: "Bill URL", key: "bill_url", width: 50 },
    ];
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF4F46E5" },
    };
    header.alignment = { vertical: "middle" };

    for (const r of data) {
      const currency =
        r.ai_raw && typeof r.ai_raw === "object" && "currency" in r.ai_raw
          ? ((r.ai_raw as { currency?: string }).currency ?? "")
          : "";
      const effDate = r.expense_date
        ? r.expense_date
        : r.created_at
          ? new Date(r.created_at).toISOString().slice(0, 10)
          : "";
      ws.addRow({
        invoice_number: r.invoice_number ?? "",
        date: effDate,
        vendor: r.vendor ?? "",
        amount: Number(r.amount ?? 0),
        currency,
        bucket: expenseBucketLabel(r.bucket),
        department: expenseDepartmentLabel(r.department),
        project_tag: r.project_tag ?? "",
        description: r.description ?? "",
        file_name: r.file_name ?? "",
        submitter: r.submitter_name ?? "",
        recorded_at: r.created_at ? new Date(r.created_at).toLocaleString("en-IN") : "",
        bill_url: r.bill_url ?? "",
      });
    }
    ws.getColumn("amount").numFmt = "#,##0.00";

    const xlsxBuffer = Buffer.from(await wb.xlsx.writeBuffer());

    // ---- Assemble the ZIP ----
    const zip = new JSZip();
    zip.file(`expenses_${month}.xlsx`, xlsxBuffer);

    const supabase = await createClient();
    const usedNames = new Set<string>();
    const skippedBills: string[] = [];

    for (const r of data) {
      let buf: Buffer | null = null;
      let ext = extOf(r.file_name, "pdf");

      if (r.bill_storage_path) {
        const { data: dl } = await supabase.storage
          .from("documents")
          .download(r.bill_storage_path);
        if (dl) {
          buf = Buffer.from(await dl.arrayBuffer());
          ext = extOf(r.bill_storage_path, ext);
        }
      }
      if (!buf && r.bill_url) {
        buf = await fetchAsBuffer(r.bill_url, "[ai-expenses/export]");
        ext = extOf(r.bill_url, ext);
      }
      if (!buf) {
        if (r.bill_url || r.bill_storage_path) {
          skippedBills.push(r.invoice_number || r.file_name || r.id);
        }
        continue;
      }

      const base = safeSlug(r.invoice_number || r.file_name?.replace(/\.[^.]+$/, "") || r.id);
      let name = `${base}.${ext}`;
      let i = 2;
      while (usedNames.has(name.toLowerCase())) {
        name = `${base}-${i}.${ext}`;
        i++;
      }
      usedNames.add(name.toLowerCase());
      zip.file(`invoices/${name}`, buf);
    }

    if (data.length === 0) {
      zip.file(
        "README.txt",
        `No AI expenses recorded for ${month}.\nThe Excel sheet is included but contains only headers.\n`,
      );
    }
    if (capped) {
      zip.file(
        "README.txt",
        `This export was capped at ${MAX_ROWS} rows for ${month}. Narrow the range to export the rest.\n`,
      );
    }
    if (skippedBills.length > 0) {
      zip.file(
        "invoices/_missing.txt",
        `These records had a bill that could not be fetched and were skipped:\n${skippedBills.join("\n")}\n`,
      );
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="expenses_${month}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e: unknown) {
    if (isNextRedirectError(e)) throw e;
    const msg = errorMessage(e);
    console.error("[ai-expenses/export] error:", msg);
    return NextResponse.json(
      { success: false, error: { message: msg } },
      { status: 500 },
    );
  }
}
