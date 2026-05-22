/**
 * CommandCentreBody — client orchestrator for the Portfolio Command Centre.
 *
 * One fetch to /api/nbfc/portfolio/command-centre, one skeleton, one error
 * state. Distributes the payload slices to the section components. The alert
 * feed is CRM-side, so this renders fully even when the IoT VPS is down.
 */
"use client";

import { useEffect, useState } from "react";
import type { CommandCentreData } from "@/lib/nbfc/command-centre";
import { inr } from "@/lib/nbfc/format";
import CommandKpiCards from "./CommandKpiCards";
import CommandNavStrip from "./CommandNavStrip";
import AlertsFeed from "./AlertsFeed";
import WeeklyPanel from "./WeeklyPanel";
import RegionalRiskPanel from "./RegionalRiskPanel";
import RecentActionsPanel from "./RecentActionsPanel";

function Skeleton() {
  return (
    <div className="space-y-6" data-testid="cc-loading">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card-iTarang p-5 animate-pulse">
            <div className="h-3 w-24 rounded bg-[color:var(--color-border)]" />
            <div className="mt-3 h-7 w-28 rounded bg-[color:var(--color-border)]" />
            <div className="mt-3 h-3 w-40 rounded bg-[color:var(--color-border)]" />
          </div>
        ))}
      </div>
      <div className="card-iTarang p-5 animate-pulse">
        <div className="h-4 w-44 rounded bg-[color:var(--color-border)]" />
        <div className="mt-4 h-24 w-full rounded bg-[color:var(--color-border)]" />
      </div>
    </div>
  );
}

export default function CommandCentreBody() {
  const [data, setData] = useState<CommandCentreData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/nbfc/portfolio/command-centre", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          let detail = `HTTP ${r.status}`;
          try {
            const body = await r.json();
            if (body?.error) detail = `${detail} — ${body.error}`;
          } catch {
            // non-JSON body — keep status only
          }
          throw new Error(detail);
        }
        return r.json();
      })
      .then((json) => {
        if (!cancelled) setData(json as CommandCentreData);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div
        className="card-iTarang p-5 text-sm"
        style={{ color: "var(--color-danger)" }}
        data-testid="cc-error"
      >
        Failed to load the Command Centre: {error}
      </div>
    );
  }
  if (!data) return <Skeleton />;

  const { kpis } = data;

  return (
    <div className="space-y-6" data-testid="cc-body">
      <p className="text-sm text-[color:var(--color-ink-muted)]">
        <span className="font-semibold text-[color:var(--color-brand-navy)]">
          {inr(kpis.active_loans.value)}
        </span>{" "}
        active loans ·{" "}
        <span className="font-semibold text-[color:var(--color-brand-navy)]">
          {inr(kpis.at_risk.value)}
        </span>{" "}
        at-risk ({kpis.at_risk.pct_of_book.toFixed(1)}%) ·{" "}
        <span className="font-semibold text-[color:var(--color-brand-navy)]">
          {kpis.delinquency_rate.value.toFixed(2)}%
        </span>{" "}
        delinquency
      </p>

      <CommandKpiCards kpis={kpis} />
      <CommandNavStrip counts={data.navCounts} />
      <AlertsFeed items={data.alertFeed} />
      <WeeklyPanel weekly={data.weekly} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <RegionalRiskPanel rows={data.regional} />
        </div>
        <RecentActionsPanel actions={data.recentActions} />
      </div>

      <div className="flex flex-col gap-1 text-[11px] text-[color:var(--color-ink-muted)]">
        <p>Computed at {new Date(data.computed_at).toLocaleString("en-IN")}</p>
        {data.errors.length > 0 ? (
          <p style={{ color: "var(--color-warning)" }} data-testid="cc-degraded">
            Some sections degraded: {data.errors.join("; ")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
