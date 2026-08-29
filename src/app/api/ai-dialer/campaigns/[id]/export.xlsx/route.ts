// GET /api/ai-dialer/campaigns/[id]/export.xlsx
//
// XLSX export of a campaign's per-lead outcomes. Mirrors the scraper-run
// export pattern (src/app/api/scraper/runs/[id]/export.xlsx/route.ts) so
// the user gets a consistent file format across the two history views.

import { deriveFailureReason } from "@/lib/ai-dialer/failureReason";
import { db } from "@/lib/db";
import {
  dialerCampaigns,
  dialerCampaignLeads,
  dealerLeads,
  aiCallLogs,
} from "@/lib/db/schema";
import { withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { deriveDurationSeconds } from "@/lib/ai-dialer/call-duration/derive";
import {
  bucketFor,
  resolveDurationBucketConfig,
} from "@/lib/ai-dialer/call-duration/config-store";
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

// Excel hard-caps a single cell at 32,767 chars. Real call transcripts are far
// shorter, but truncate defensively so a runaway transcript can't corrupt the
// whole file.
const TRANSCRIPT_CELL_MAX = 32000;
function transcriptCell(t: string | null | undefined): string {
  const trimmed = (t ?? "").trim();
  if (!trimmed) return "—";
  return trimmed.length > TRANSCRIPT_CELL_MAX
    ? `${trimmed.slice(0, TRANSCRIPT_CELL_MAX)} …[truncated]`
    : trimmed;
}

// One place the export derives the reason, so the sheet and the screen agree.
function failureReasonOf(r: {
  status: string | null;
  call_outcome: string | null;
  transcript: string | null;
  log_status: string | null;
  log_call_status: string | null;
}) {
  return deriveFailureReason({
    status: r.status,
    callOutcome: r.call_outcome,
    hasTranscript: r.transcript != null,
    providerStatus: r.log_status,
    bandCallStatus: r.log_call_status,
  });
}

/** The same duration the lead table, the drawer and the histogram all show. */
function durationOf(r: {
  call_duration: number | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  transcript: string | null;
}) {
  // `transcript` is what licenses the wall-clock fallback. Without it a
  // trigger_failed lead exports the seconds the dialer spent failing as though
  // a dealer had talked for them.
  return deriveDurationSeconds(
    r.call_duration,
    r.started_at,
    r.completed_at,
    r.transcript != null,
  );
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
      // Same reason as the advance route: the Export Excel button ships with
      // the campaign detail view, which these two dashboards now mount.
      "inside_sales_rep",
      "asm",
    ]);

    const { id } = await params;

    // Resolved alongside the rows so the sheet's bucket labels are the same
    // ones the on-screen histogram was drawn with.
    const [campaignRow, leadRows, { buckets: durationBuckets }] = await Promise.all([
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
          // Transcript is keyed by the conversation id that the dialer stores
          // in bolna_call_id (true for both Bolna and ElevenLabs). Joining here
          // backfills transcripts for current AND previous campaigns from
          // whatever is already persisted in ai_call_logs.
          transcript: aiCallLogs.transcript,
          // Same already-joined row — the evidence behind the failure reason.
          log_status: aiCallLogs.status,
          log_call_status: aiCallLogs.call_status,
          // Same already-joined row again. Duration is derived rather than read
          // straight off this column — see deriveDurationSeconds.
          call_duration: aiCallLogs.call_duration,
        })
        .from(dialerCampaignLeads)
        .leftJoin(dealerLeads, eq(dealerLeads.id, dialerCampaignLeads.lead_id))
        .leftJoin(
          aiCallLogs,
          eq(aiCallLogs.call_id, dialerCampaignLeads.bolna_call_id),
        )
        .where(eq(dialerCampaignLeads.campaign_id, id))
        .orderBy(asc(dialerCampaignLeads.queue_position)),
      resolveDurationBucketConfig(),
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
      // Why the call produced no conversation, in the same words the campaign
      // table shows. The raw outcome column stays beside it: the derived reason
      // is for reading, the raw string is for debugging.
      { header: "Failure Reason", key: "failure_reason", width: 24 },
      { header: "Retryable", key: "retryable", width: 11 },
      { header: "Intent Score", key: "intent_score", width: 14 },
      { header: "Lead Score", key: "final_intent_score", width: 14 },
      { header: "Current Status", key: "current_status", width: 16 },
      { header: "Started", key: "started_at", width: 22 },
      { header: "Ended", key: "completed_at", width: 22 },
      // Duration sits with the timestamps it is derived from, and before the
      // debug columns. Written as a NUMBER, not "0m 12s", so the column sorts
      // and averages in Excel — the point of exporting it at all.
      { header: "Duration (s)", key: "duration_seconds", width: 14 },
      { header: "Duration Bucket", key: "duration_bucket", width: 16 },
      { header: "Call Id", key: "call_id", width: 28 },
      { header: "Transcription", key: "transcription", width: 80 },
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
        failure_reason: failureReasonOf(r)?.label ?? "—",
        // Blank rather than "No" for a successful call — "No" would read as
        // "do not retry this", which is a different statement from "this one
        // worked".
        retryable: (() => {
          const fr = failureReasonOf(r);
          return fr ? (fr.retryable ? "Yes" : "No") : "—";
        })(),
        intent_score: r.intent_score ?? "—",
        final_intent_score: r.final_intent_score ?? "—",
        current_status: r.current_status ?? "—",
        started_at: fmt(r.started_at),
        completed_at: fmt(r.completed_at),
        duration_seconds: durationOf(r) ?? "—",
        duration_bucket: bucketFor(durationOf(r), durationBuckets)?.label ?? "—",
        call_id: r.bolna_call_id ?? "—",
        transcription: transcriptCell(r.transcript),
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
