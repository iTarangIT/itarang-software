/**
 * DataFreshnessBadge (E-027 — BRD §6.1.3)
 *
 * Shows "Last updated: <date>, <time> IST" using the most recent of the
 * tenant's CDS / telemetry timestamps. When the freshness API reports
 * is_stale=true, the badge turns amber and shows the BRD's exact copy:
 * "Data may be outdated — IoT sync issue".
 *
 * Timestamps are always rendered in Asia/Kolkata regardless of viewer locale
 * (BRD non-functional requirement).
 */
"use client";

import { useEffect, useState } from "react";

interface FreshnessResponse {
  cds_last_computed_at: string | null;
  telemetry_last_ingested_at: string | null;
  is_stale: boolean;
}

const IST_FMT = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

function formatIst(iso: string | null): string {
  if (!iso) return "unknown";
  return `${IST_FMT.format(new Date(iso))} IST`;
}

function pickLatest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

export default function DataFreshnessBadge() {
  const [data, setData] = useState<FreshnessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/nbfc/portfolio/freshness", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => {
        if (!cancelled) setData(json as FreshnessResponse);
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
      <span
        data-testid="data-freshness-badge"
        data-stale="true"
        className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
      >
        Data may be outdated — IoT sync issue
      </span>
    );
  }
  if (!data) {
    return (
      <span
        data-testid="data-freshness-badge"
        className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500"
      >
        Loading freshness…
      </span>
    );
  }

  if (data.is_stale) {
    return (
      <span
        data-testid="data-freshness-badge"
        data-stale="true"
        className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
      >
        Data may be outdated — IoT sync issue
      </span>
    );
  }

  const latest = pickLatest(
    data.cds_last_computed_at,
    data.telemetry_last_ingested_at,
  );
  return (
    <span
      data-testid="data-freshness-badge"
      data-stale="false"
      className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"
    >
      Last updated: {formatIst(latest)}
    </span>
  );
}
