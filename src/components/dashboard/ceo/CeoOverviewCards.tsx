"use client";

/**
 * E-219 — the CEO landing page's headline cards, fed by /api/dashboard/ceo/overview.
 *
 * Green KM is deliberately NOT here: it reads a different database over a
 * tunnel that is regularly down, so it fetches separately (see GreenKmCard) and
 * fails on its own rather than taking these three with it.
 */

import React from "react";
import { KPICard } from "@/components/shared/kpi-card";
import { formatINRCompact, formatINRExact } from "@/lib/format";
import { Recycle, Users, Wallet } from "lucide-react";

export interface CeoOverviewData {
  period: string;
  label: string;
  granularity: "day" | "week" | "month";
  realization: {
    revenue: number;
    expense: number;
    outstanding: number;
    realization: number;
  };
  /**
   * total/aiQualified are leads CREATED in the window; converted is deals
   * marked Converted whose closed_at is in the window (same rule as the Sales
   * dashboard). aiQualified is the dialer's intent rating — never a conversion.
   */
  leads: { total: number; converted: number; aiQualified: number };
  buyback: { available: boolean; submitted: number; completed: number };
  chart: {
    name: string;
    revenue: number;
    expense: number;
    realization: number;
  }[];
}

export function RealizationCard({
  data,
  windowLabel,
  onClick,
}: {
  data: CeoOverviewData["realization"];
  windowLabel: string;
  onClick: () => void;
}) {
  // ID 89 — KpiTile's look (redesign primitives), as a button: the tile opens
  // the realization breakdown. Only the Revenue & costs page uses it.
  return (
    <button
      type="button"
      onClick={onClick}
      title={formatINRExact(data.realization)}
      className="flex w-full flex-col gap-2 rounded-2xl border border-border bg-surface p-[18px] text-left shadow-card transition hover:border-brand-sky hover:shadow-md"
    >
      <span className="flex items-center gap-2 text-[13px] font-semibold text-ink-muted">
        <Wallet className="h-4 w-4 text-brand-royal" aria-hidden />
        Realization
      </span>
      <span className="text-[27px] font-bold leading-tight tracking-tight text-brand-navy tabular-nums">
        {formatINRCompact(data.realization)}
      </span>
      <span className="text-xs leading-snug text-ink-muted">Revenue − expense · {windowLabel}</span>
      <span className="text-xs font-semibold text-brand-navy">See how it adds up →</span>
    </button>
  );
}

export function LeadsCard({
  data,
  windowLabel,
}: {
  data: CeoOverviewData["leads"];
  windowLabel: string;
}) {
  return (
    <KPICard
      title="Leads"
      value={data.total.toLocaleString("en-IN")}
      subtitle={
        data.total > 0 || data.converted > 0
          ? `${data.converted.toLocaleString("en-IN")} converted · ${data.aiQualified.toLocaleString("en-IN")} AI qualified · ${windowLabel}`
          : `No leads in ${windowLabel}`
      }
      icon={Users}
    />
  );
}

export function BuybackCard({
  data,
  windowLabel,
}: {
  data: CeoOverviewData["buyback"];
  windowLabel: string;
}) {
  // The buyback schema (E-185_buyback_core) is not applied on production. Say
  // so plainly — a card reading "0 requests" would be indistinguishable from a
  // month in which nobody recycled anything.
  if (!data.available) {
    return (
      <KPICard
        title="Responsible Recycling"
        value="—"
        subtitle="Buyback tables not present in this environment"
        icon={Recycle}
      />
    );
  }

  return (
    <KPICard
      title="Responsible Recycling"
      value={data.submitted.toLocaleString("en-IN")}
      subtitle={
        data.submitted > 0
          ? `${data.completed.toLocaleString("en-IN")} completed · ${Math.round(
              (data.completed / data.submitted) * 100,
            )}%`
          : `No requests submitted in ${windowLabel}`
      }
      icon={Recycle}
    />
  );
}
