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
  leads: { total: number; converted: number };
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
  return (
    <KPICard
      title="Realization"
      value={formatINRCompact(data.realization)}
      exactValue={formatINRExact(data.realization)}
      subtitle={`Revenue − expense · ${windowLabel}`}
      icon={Wallet}
      onClick={onClick}
    />
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
        data.total > 0
          ? `${data.converted.toLocaleString("en-IN")} qualified · ${windowLabel}`
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
