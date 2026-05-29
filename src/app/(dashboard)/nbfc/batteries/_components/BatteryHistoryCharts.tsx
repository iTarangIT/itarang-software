"use client";

/**
 * BatteryHistoryCharts — SOC / SOH 30-day trend charts for one battery
 * (BRD §6.2.7). Fetches the per-battery history endpoint and renders two
 * responsive Recharts panels. Degrades to a quiet notice when the VPS has no
 * telemetry for the window.
 */
import { useEffect, useState } from "react";
import { MetricsChart } from "@/components/shared/charts";

type HistoryPoint = {
  date: string;
  value: number | { lat: number; lng: number } | null;
};

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });

export default function BatteryHistoryCharts({
  serialNumber,
}: {
  serialNumber: string;
}) {
  const [soc, setSoc] = useState<{ label: string; soc: number }[]>([]);
  const [soh, setSoh] = useState<{ label: string; soh: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 24 * 3600 * 1000);
    const qs = `from=${ymd(from)}&to=${ymd(to)}`;
    const base = `/api/nbfc/iot/battery/${encodeURIComponent(serialNumber)}/history`;

    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const [socRes, sohRes] = await Promise.all([
          fetch(`${base}?${qs}&metric=soc`, { cache: "no-store" }),
          fetch(`${base}?${qs}&metric=soh`, { cache: "no-store" }),
        ]);
        const socJson = await socRes.json();
        const sohJson = await sohRes.json();
        if (cancelled) return;
        if (!socRes.ok) {
          throw new Error(socJson?.error || `HTTP ${socRes.status}`);
        }
        if (!sohRes.ok) {
          throw new Error(sohJson?.error || `HTTP ${sohRes.status}`);
        }
        const socPts = (socJson.points as HistoryPoint[] | undefined) ?? [];
        const sohPts = (sohJson.points as HistoryPoint[] | undefined) ?? [];
        setSoc(
          socPts
            .filter((p) => typeof p.value === "number")
            .map((p) => ({ label: fmtDay(p.date), soc: p.value as number })),
        );
        setSoh(
          sohPts
            .filter((p) => typeof p.value === "number")
            .map((p) => ({ label: fmtDay(p.date), soh: p.value as number })),
        );
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [serialNumber]);

  if (loading) {
    return (
      <p className="text-xs italic text-[color:var(--color-ink-muted)]">
        Loading SOC / SOH history…
      </p>
    );
  }
  if (error) {
    return (
      <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        Telemetry history unavailable — {error}
      </div>
    );
  }
  if (soc.length === 0 && soh.length === 0) {
    return (
      <p className="text-xs italic text-[color:var(--color-ink-muted)]">
        No telemetry history in the last 30 days.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {soc.length > 0 ? (
        <MetricsChart
          title="State of Charge — last 30 days"
          data={soc}
          type="area"
          dataKeys={["soc"]}
          categoryKey="label"
          height={220}
        />
      ) : null}
      {soh.length > 0 ? (
        <MetricsChart
          title="State of Health — last 30 days"
          data={soh}
          type="line"
          dataKeys={["soh"]}
          categoryKey="label"
          height={220}
          colors={["#138fc6"]}
        />
      ) : null}
    </div>
  );
}
