// GET /api/ai-dialer/campaigns/[id]/export.xlsx
//
// XLSX export of a campaign's per-lead outcomes. Mirrors the scraper-run
// export pattern (src/app/api/scraper/runs/[id]/export.xlsx/route.ts) so
// the user gets a consistent file format across the two history views.

import { db } from "@/lib/db";
import {
  dialerCampaigns,
  dialerCampaignLeads,
  dealerLeads,
} from "@/lib/db/schema";
import { withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { asc, eq } from "drizzle-orm";
import ExcelJS from "exceljs";

function styleHeader(row: ExcelJS.Row) {
  row.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1A1A1A" },
    };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  row.height = 28;
}

function fmt(d: Date | null | undefined): string {
  return d
    ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
    : "—";
}

export const GET = withErrorHandler(
  async (
    _req: Request,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    await requireRole([
      "ceo",
      "business_head",
      "sales_head",
      "sales_manager",
      "sales_executive",
      "admin",
    ]);

    const { id } = await params;

    const [campaignRow, leadRows] = await Promise.all([
      db
        .select()
        .from(dialerCampaigns)
        .where(eq(dialerCampaigns.id, id))
        .limit(1)
        .then((r) => r[0] ?? null),
      db
        .select({
          queue_position: dialerCampaignLeads.queue_position,
          status: dialerCampaignLeads.status,
          call_outcome: dialerCampaignLeads.call_outcome,
          intent_score: dialerCampaignLeads.intent_score,
          started_at: dialerCampaignLeads.started_at,
          completed_at: dialerCampaignLeads.completed_at,
          bolna_call_id: dialerCampaignLeads.bolna_call_id,
          shop_name: dealerLeads.shop_name,
          dealer_name: dealerLeads.dealer_name,
          phone: dealerLeads.phone,
          city: dealerLeads.city,
          state: dealerLeads.state,
          final_intent_score: dealerLeads.final_intent_score,
          current_status: dealerLeads.current_status,
        })
        .from(dialerCampaignLeads)
        .leftJoin(dealerLeads, eq(dealerLeads.id, dialerCampaignLeads.lead_id))
        .where(eq(dialerCampaignLeads.campaign_id, id))
        .orderBy(asc(dialerCampaignLeads.queue_position)),
    ]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "iTarang";
    workbook.created = new Date();

    if (campaignRow) {
      const meta = workbook.addWorksheet("Campaign");
      meta.columns = [
        { header: "Field", key: "k", width: 22 },
        { header: "Value", key: "v", width: 60 },
      ];
      styleHeader(meta.getRow(1));
      const entries: [string, any][] = [
        ["Name", campaignRow.name],
        ["Status", campaignRow.status],
        ["Provider", campaignRow.provider],
        ["Segment", campaignRow.category ?? "—"],
        ["Total leads", campaignRow.total_leads],
        ["Calls made", campaignRow.calls_made],
        ["Completed", campaignRow.completed_leads],
        ["Failed", campaignRow.failed_leads],
        ["Started", fmt(campaignRow.started_at)],
        ["Completed", fmt(campaignRow.completed_at)],
        [
          "Region filter",
          campaignRow.region_filter
            ? JSON.stringify(campaignRow.region_filter)
            : "—",
        ],
      ];
      entries.forEach(([k, v]) => meta.addRow({ k, v }));
    }

    const sheet = workbook.addWorksheet("Leads", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    sheet.columns = [
      { header: "#", key: "queue_position", width: 6 },
      { header: "Shop / Dealer", key: "name", width: 36 },
      { header: "Phone", key: "phone", width: 18 },
      { header: "City", key: "city", width: 16 },
      { header: "State", key: "state", width: 16 },
      { header: "Status", key: "status", width: 14 },
      { header: "Call Outcome", key: "outcome", width: 22 },
      { header: "Intent Score", key: "intent_score", width: 14 },
      { header: "Lead Score", key: "final_intent_score", width: 14 },
      { header: "Current Status", key: "current_status", width: 16 },
      { header: "Started", key: "started_at", width: 22 },
      { header: "Ended", key: "completed_at", width: 22 },
      { header: "Call Id", key: "call_id", width: 28 },
    ];
    styleHeader(sheet.getRow(1));

    leadRows.forEach((r, i) => {
      const row = sheet.addRow({
        queue_position: (r.queue_position ?? 0) + 1,
        name: r.shop_name || r.dealer_name || "—",
        phone: r.phone ?? "—",
        city: r.city ?? "—",
        state: r.state ?? "—",
        status: r.status,
        outcome: r.call_outcome ?? "—",
        intent_score: r.intent_score ?? "—",
        final_intent_score: r.final_intent_score ?? "—",
        current_status: r.current_status ?? "—",
        started_at: fmt(r.started_at),
        completed_at: fmt(r.completed_at),
        call_id: r.bolna_call_id ?? "—",
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
        cell.border = {
          bottom: { style: "hair", color: { argb: "FFE5E7EB" } },
        };
      });
    });

    if (leadRows.length > 0) {
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: sheet.columns.length },
      };
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `dialer_campaign_${safeId}.xlsx`;

    return new Response(Buffer.from(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": buffer.byteLength.toString(),
        "Cache-Control": "no-store",
      },
    });
  },
);
