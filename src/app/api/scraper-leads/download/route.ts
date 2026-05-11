/**
 * GET /api/scraper-leads/download
 *
 * Excel export of every scraped lead across every scraper run, with the
 * scraper run id + run-start time included on each row so the recipient
 * can sort/filter by run inside Excel.
 *
 * Mirrors the pattern in /api/scraper-leads/converted/download/route.ts.
 */

import { db } from "@/lib/db";
import { scrapedDealerLeads, scraperRuns } from "@/lib/db/schema";
import { withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { desc, eq } from "drizzle-orm";
import ExcelJS from "exceljs";

export const GET = withErrorHandler(async () => {
  await requireRole(["sales_manager", "sales_head", "ceo", "business_head"]);

  // Join leads → runs so we can show run.started_at alongside each lead.
  const rows = await db
    .select({
      id: scrapedDealerLeads.id,
      scraper_run_id: scrapedDealerLeads.scraper_run_id,
      dealer_name: scrapedDealerLeads.dealer_name,
      phone: scrapedDealerLeads.phone,
      email: scrapedDealerLeads.email,
      city: scrapedDealerLeads.location_city,
      state: scrapedDealerLeads.location_state,
      business_type: scrapedDealerLeads.business_type,
      source_url: scrapedDealerLeads.source_url,
      created_at: scrapedDealerLeads.created_at,
      run_started_at: scraperRuns.started_at,
      run_status: scraperRuns.status,
    })
    .from(scrapedDealerLeads)
    .leftJoin(
      scraperRuns,
      eq(scrapedDealerLeads.scraper_run_id, scraperRuns.id),
    )
    .orderBy(desc(scrapedDealerLeads.created_at));

  console.log(`[DOWNLOAD] Scraped leads: ${rows.length}`);

  // ── Build Excel ───────────────────────────────────────────
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "iTarang";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Scraped Leads", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: "Name", key: "name", width: 28 },
    { header: "Company Name", key: "company_name", width: 28 },
    { header: "Phone Number", key: "phone", width: 18 },
    { header: "Email", key: "email", width: 28 },
    { header: "Address", key: "address", width: 32 },
    { header: "Scraper Run ID", key: "scraper_run_id", width: 26 },
    { header: "Run Started At", key: "run_started_at", width: 22 },
    { header: "Scraped At", key: "scraped_at", width: 22 },
    { header: "Business Type", key: "business_type", width: 20 },
    { header: "Source URL", key: "source_url", width: 36 },
  ];

  // Header row styling — same dark-bar style as converted-leads export
  sheet.getRow(1).eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1A1A1A" },
    };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  sheet.getRow(1).height = 28;

  rows.forEach((r, i) => {
    const address = [r.city, r.state].filter(Boolean).join(", ") || "—";
    const fmt = (d: Date | null | undefined) =>
      d
        ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
        : "—";

    const row = sheet.addRow({
      name: r.dealer_name ?? "—",
      company_name: r.dealer_name ?? "—",
      phone: r.phone ?? "—",
      email: r.email ?? "—",
      address,
      scraper_run_id: r.scraper_run_id,
      run_started_at: fmt(r.run_started_at),
      scraped_at: fmt(r.created_at),
      business_type: r.business_type ?? "—",
      source_url: r.source_url ?? "—",
    });

    if (i % 2 === 0) {
      row.eachCell((cell) => {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF9FAFB" },
        };
      });
    }
    row.eachCell((cell) => {
      cell.alignment = { vertical: "middle", wrapText: true };
      cell.border = { bottom: { style: "hair", color: { argb: "FFE5E7EB" } } };
    });
    row.height = 22;
  });

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: sheet.columns.length },
  };

  // Per-run summary tab (count of leads per run)
  const runCounts = new Map<
    string,
    { count: number; started_at: Date | null; status: string | null }
  >();
  for (const r of rows) {
    const k = r.scraper_run_id;
    const cur = runCounts.get(k) ?? {
      count: 0,
      started_at: r.run_started_at ?? null,
      status: r.run_status ?? null,
    };
    cur.count += 1;
    runCounts.set(k, cur);
  }

  const summary = workbook.addWorksheet("Runs Summary");
  summary.columns = [
    { header: "Scraper Run ID", key: "run_id", width: 26 },
    { header: "Started At", key: "started_at", width: 22 },
    { header: "Status", key: "status", width: 14 },
    { header: "Leads", key: "count", width: 10 },
  ];
  summary.getRow(1).eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1A1A1A" },
    };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  summary.getRow(1).height = 24;

  Array.from(runCounts.entries())
    .sort(
      (a, b) =>
        (b[1].started_at?.getTime() ?? 0) - (a[1].started_at?.getTime() ?? 0),
    )
    .forEach(([run_id, info]) => {
      summary.addRow({
        run_id,
        started_at: info.started_at
          ? new Date(info.started_at).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
            })
          : "—",
        status: info.status ?? "—",
        count: info.count,
      });
    });

  summary.addRow({});
  summary.addRow({ run_id: "TOTAL", count: rows.length }).font = { bold: true };
  summary.addRow({
    run_id: "Downloaded At",
    started_at: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `iTarang_Scraped_Leads_${new Date().toISOString().slice(0, 10)}.xlsx`;

  return new Response(Buffer.from(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": buffer.byteLength.toString(),
    },
  });
});
