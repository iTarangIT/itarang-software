// CSV export of campaign cost data. Mirrors the converted-leads export
// pattern (sales-insight) — same RFC 4180 encoder, same UTF-8 BOM, same
// in-memory build. Two modes:
//
//   - No campaign_id: row per (campaign, day) so finance can pivot in Excel
//   - With campaign_id: row per call with full component breakdown for
//     audit / reconciliation
//
// INR conversion happens here (server side) so the file is self-contained
// — the recipient doesn't need to know the env var rate.

import { db } from "@/lib/db";
import { withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import {
  buildTopCampaignsSql,
  buildCallDetailSql,
  type CostAnalyticsFilters,
} from "@/lib/campaigns/cost-analytics-query";
import { usdCentsToInr, getUsdToInrRate } from "@/lib/currency";

const ALLOWED_ROLES = [
  "ceo",
  "business_head",
  "sales_head",
  "finance_controller",
  "admin",
] as const;

const MAX_EXPORT_ROWS = 50_000;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function unwrap<T>(r: { rows: T[] } | T[]): T[] {
  if (Array.isArray(r)) return r;
  return r.rows ?? [];
}

function inrCell(usdCents: number | null | undefined): string {
  if (usdCents == null) return "";
  return usdCentsToInr(usdCents).toFixed(2);
}

export const GET = withErrorHandler(async (req: Request) => {
  await requireRole([...ALLOWED_ROLES]);

  const { searchParams } = new URL(req.url);
  const campaignId = searchParams.get("campaign_id");
  const provider = searchParams.get("provider");
  const validProvider =
    provider === "bolna" || provider === "elevenlabs" ? provider : null;

  const filters: CostAnalyticsFilters = {
    from_date: searchParams.get("from_date") || null,
    to_date: searchParams.get("to_date") || null,
    provider: validProvider,
    campaign_id: campaignId,
    page: 1,
    limit: MAX_EXPORT_ROWS,
  };

  const rate = getUsdToInrRate();
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  let filename: string;

  if (campaignId) {
    // Per-call detail for one campaign
    const detail = unwrap(
      (await db.execute(buildCallDetailSql(filters))) as unknown as Array<
        Record<string, unknown>
      >,
    );

    lines.push(
      [
        "Call ID",
        "Provider",
        "Status",
        "Shop Name",
        "Phone",
        "Started At (IST)",
        "Ended At (IST)",
        "Duration (sec)",
        "Total Cost (INR)",
        "LLM (INR)",
        "TTS (INR)",
        "STT (INR)",
        "Telephony (INR)",
        "Platform (INR)",
        "Cost Captured At",
      ].join(","),
    );

    for (const r of detail) {
      const fmt = (iso: unknown) =>
        iso
          ? new Date(iso as string).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
            })
          : "";
      lines.push(
        [
          csvCell(r.call_id),
          csvCell(r.provider),
          csvCell(r.status),
          csvCell(r.shop_name),
          csvCell(r.phone),
          csvCell(fmt(r.started_at)),
          csvCell(fmt(r.ended_at)),
          csvCell(r.duration_secs),
          csvCell(inrCell(r.total_cost_cents as number | null)),
          csvCell(inrCell(r.llm_cost_cents as number | null)),
          csvCell(inrCell(r.tts_cost_cents as number | null)),
          csvCell(inrCell(r.stt_cost_cents as number | null)),
          csvCell(inrCell(r.telephony_cost_cents as number | null)),
          csvCell(inrCell(r.platform_cost_cents as number | null)),
          csvCell(fmt(r.cost_fetched_at)),
        ].join(","),
      );
    }
    filename = `iTarang_Campaign_${campaignId}_Costs_${today}.csv`;
  } else {
    // Top campaigns summary export
    const top = unwrap(
      (await db.execute(buildTopCampaignsSql(filters))) as unknown as Array<
        Record<string, unknown>
      >,
    );

    lines.push(
      [
        "Campaign ID",
        "Name",
        "Provider",
        "Started At (IST)",
        "Calls Made",
        "Calls with Cost",
        "Total Duration (sec)",
        "Total Cost (INR)",
        "Avg Cost / Call (INR)",
      ].join(","),
    );

    for (const r of top) {
      const startedAt = r.started_at
        ? new Date(r.started_at as string).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
          })
        : "";
      const totalCents = Number(r.total_cost_cents ?? 0);
      const costCalls = Number(r.cost_calls ?? 0);
      const avgCents =
        costCalls > 0 ? Math.round(totalCents / costCalls) : 0;
      lines.push(
        [
          csvCell(r.id),
          csvCell(r.name),
          csvCell(r.provider),
          csvCell(startedAt),
          csvCell(r.calls_made),
          csvCell(r.cost_calls),
          csvCell(r.total_duration_secs),
          csvCell(inrCell(totalCents)),
          csvCell(inrCell(avgCents)),
        ].join(","),
      );
    }
    filename = `iTarang_Campaigns_Cost_${today}.csv`;
  }

  // Footnote: include the conversion rate at the bottom so reviewers can
  // reproduce the numbers without checking env vars.
  lines.push("");
  lines.push(`# USD->INR rate applied: ${rate}`);
  lines.push(`# Exported: ${new Date().toISOString()}`);

  const body = "﻿" + lines.join("\r\n");

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});
