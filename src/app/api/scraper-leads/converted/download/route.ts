/**
 * app/api/scraper-leads/converted/download/route.ts
 */

import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { desc } from "drizzle-orm";
import ExcelJS from "exceljs";

export const GET = withErrorHandler(async () => {
  await requireRole(["sales_manager", "sales_head", "ceo", "business_head"]);

  // Fetch all dealer leads (same as the UI — no status filter)
  const allLeads = await db
    .select()
    .from(dealerLeads)
    .orderBy(desc(dealerLeads.created_at));

  // Apply the exact same filter the UI uses:
  // last follow-up history entry has intent_score >= 80
  const leads = allLeads.filter((lead: any) => {
    const history = lead.follow_up_history || [];
    if (!history.length) return false;
    const lastAttempt = history[history.length - 1];
    return lastAttempt?.analysis?.intent_score >= 80;
  });

  console.log(`[DOWNLOAD] Converted leads (intent >= 80): ${leads.length}`);

  // ── Build Excel ───────────────────────────────────────────
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "iTarang";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Converted Leads", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: "Lead ID", key: "id", width: 22 },
    { header: "Shop Name", key: "shop_name", width: 28 },
    { header: "Dealer Name", key: "dealer_name", width: 24 },
    { header: "Phone", key: "phone", width: 18 },
    { header: "Location", key: "location", width: 20 },
    { header: "Status", key: "current_status", width: 16 },
    { header: "Intent Score", key: "final_intent_score", width: 16 },
    { header: "Total Attempts", key: "total_attempts", width: 16 },
    { header: "Assigned To", key: "assigned_to", width: 20 },
    { header: "Last Outcome", key: "last_outcome", width: 22 },
    { header: "Overall Summary", key: "overall_summary", width: 40 },
    { header: "Created At", key: "created_at", width: 24 },
  ];

  // Header row styling
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

  leads.forEach((lead: any, i: number) => {
    const history = lead.follow_up_history || [];
    const lastAttempt = history[history.length - 1];
    const lastOutcome = lastAttempt?.outcome ?? "—";

    const row = sheet.addRow({
      id: lead.id,
      shop_name: lead.shop_name ?? "—",
      dealer_name: lead.dealer_name ?? "—",
      phone: lead.phone ?? "—",
      location: lead.location ?? "—",
      current_status: lead.current_status ?? "—",
      final_intent_score: lead.final_intent_score ?? "—",
      total_attempts: lead.total_attempts ?? 0,
      assigned_to: lead.assigned_to ?? "—",
      last_outcome: lastOutcome,
      overall_summary: lead.overall_summary ?? "—",
      created_at: lead.created_at
        ? new Date(lead.created_at).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
          })
        : "—",
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
      cell.alignment = { vertical: "middle" };
      cell.border = { bottom: { style: "hair", color: { argb: "FFE5E7EB" } } };
    });
    row.height = 22;
  });

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: sheet.columns.length },
  };

  // Summary tab
  const summary = workbook.addWorksheet("Summary");
  summary.columns = [
    { header: "Metric", key: "metric", width: 28 },
    { header: "Value", key: "value", width: 24 },
  ];
  summary.getRow(1).font = { bold: true };
  [
    { metric: "Total Converted Leads", value: leads.length },
    {
      metric: "Downloaded At",
      value: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    },
  ].forEach((r) => summary.addRow(r));

  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `iTarang_Converted_Leads_${new Date().toISOString().slice(0, 10)}.xlsx`;

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
