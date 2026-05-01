"use client";

/**
 * E-065 — Ecosystem Overview admin dashboard (BRD §6.3.2).
 *
 * Renders 7 metric tiles + the cross-NBFC comparison table. Fetches from
 * GET /api/admin/nbfc/ecosystem-overview on mount.
 */
import { useEffect, useState } from "react";
import type { EcosystemOverviewResponse } from "@/lib/nbfc/ecosystem-overview";
import CrossNbfcComparisonTable from "./CrossNbfcComparisonTable";

type Props = {
  /** Test override; defaults to fetch(). */
  fetcher?: typeof fetch;
};

function fmtInr(n: number): string {
  // Compact ₹ rendering — BRD calls for INR formatting on numeric tiles.
  if (n >= 1e7) return `Rs ${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `Rs ${(n / 1e5).toFixed(2)} L`;
  return `Rs ${new Intl.NumberFormat("en-IN").format(Math.round(n))}`;
}

function fmtInt(n: number): string {
  return new Intl.NumberFormat("en-IN").format(Math.round(n));
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function Tile({
  label,
  value,
  testid,
}: {
  label: string;
  value: string;
  testid: string;
}) {
  return (
    <div
      className="rounded-md border border-gray-200 bg-white p-4 shadow-sm"
      data-testid={testid}
    >
      <div className="text-xs uppercase tracking-wide text-gray-500">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-gray-900">{value}</div>
    </div>
  );
}

export default function EcosystemOverview({ fetcher }: Props) {
  const fx = fetcher ?? fetch;
  const [data, setData] = useState<EcosystemOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fx("/api/admin/nbfc/ecosystem-overview");
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = (await res.json()) as EcosystemOverviewResponse;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fx]);

  if (loading) {
    return (
      <div className="text-sm text-gray-500" data-testid="ecosystem-loading">
        Loading ecosystem overview…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div
        className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700"
        data-testid="ecosystem-error"
      >
        Failed to load ecosystem overview: {error ?? "no data"}
      </div>
    );
  }

  const { tiles, comparison } = data;
  const alerts = tiles.alerts_24h;
  const alertsTotal = alerts.critical + alerts.warning + alerts.info;

  return (
    <div className="space-y-6" data-testid="ecosystem-overview">
      <section>
        <h2 className="mb-3 text-lg font-semibold text-gray-900">
          Ecosystem Overview
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            label="Connected NBFCs"
            value={fmtInt(tiles.connected_nbfcs)}
            testid="tile-connected-nbfcs"
          />
          <Tile
            label="Total Portfolio"
            value={fmtInr(tiles.total_portfolio_inr)}
            testid="tile-total-portfolio"
          />
          <Tile
            label="Batteries in Field"
            value={fmtInt(tiles.batteries_in_field)}
            testid="tile-batteries-in-field"
          />
          <Tile
            label="IoT Connectivity"
            value={fmtPct(tiles.iot_connectivity_pct)}
            testid="tile-iot-connectivity"
          />
          <Tile
            label="Platform Uptime"
            value={fmtPct(tiles.platform_uptime_pct)}
            testid="tile-platform-uptime"
          />
          <Tile
            label="Alerts (24h)"
            value={`${fmtInt(alertsTotal)} (C ${alerts.critical} / W ${alerts.warning} / I ${alerts.info})`}
            testid="tile-alerts-24h"
          />
          <Tile
            label="Avg CDS (Network)"
            value={tiles.avg_cds_network.toFixed(1)}
            testid="tile-avg-cds-network"
          />
        </div>
      </section>
      <section>
        <h3 className="mb-3 text-base font-semibold text-gray-900">
          Cross-NBFC Comparison
        </h3>
        <CrossNbfcComparisonTable rows={comparison} />
      </section>
    </div>
  );
}
