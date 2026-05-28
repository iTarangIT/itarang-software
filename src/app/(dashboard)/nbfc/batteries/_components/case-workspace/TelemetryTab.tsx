"use client";

import { useEffect, useState } from "react";
import BatteryHistoryCharts from "../BatteryHistoryCharts";
import type { CaseWarranty } from "./types";

interface StateSnapshot {
  soc_pct: number | null;
  soh_pct: number | null;
  charge_cycles: number | null;
  pack_temp_c: number | null;
  last_seen: string | null;
}

interface Props {
  serialNumber: string | null;
  warranty: CaseWarranty | null;
}

function Tile({
  label,
  value,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  icon?: string;
}) {
  return (
    <div className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-3">
      <p className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
        {icon ? `${icon} ` : ""}
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold text-[color:var(--color-ink)] tabular-nums">
        {value ?? "—"}
      </p>
    </div>
  );
}

export function TelemetryTab({ serialNumber, warranty }: Props) {
  const [snapshot, setSnapshot] = useState<StateSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!serialNumber) {
      setLoaded(true);
      return;
    }
    async function load(serial: string) {
      try {
        const res = await fetch(
          `/api/nbfc/iot/battery/${encodeURIComponent(serial)}/state`,
          { cache: "no-store" },
        );
        if (!res.ok) {
          if (!cancelled) setLoaded(true);
          return;
        }
        const body = await res.json();
        if (cancelled) return;
        setSnapshot({
          soc_pct: body?.soc_pct ?? null,
          soh_pct: body?.soh_pct ?? null,
          charge_cycles: body?.charge_cycles ?? null,
          pack_temp_c: body?.pack_temp_c ?? null,
          last_seen: body?.last_seen ?? body?.last_gps_at ?? null,
        });
        setLoaded(true);
      } catch {
        if (!cancelled) setLoaded(true);
      }
    }
    load(serialNumber);
    return () => {
      cancelled = true;
    };
  }, [serialNumber]);

  function fmtLastSeen(ts: string | null) {
    if (!ts) return "—";
    const ms = Date.now() - Date.parse(ts);
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 48) return `${hrs} hr ago`;
    return new Date(ts).toLocaleString("en-IN");
  }

  return (
    <div className="space-y-4">
      <section>
        <h4 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
          📺 SOH · 30-day trend
        </h4>
        {serialNumber ? (
          <BatteryHistoryCharts serialNumber={serialNumber} />
        ) : (
          <p className="rounded border border-dashed border-[color:var(--color-border)] p-4 text-sm italic text-[color:var(--color-ink-muted)]">
            No serial linked — telemetry unavailable.
          </p>
        )}
      </section>

      <section className="grid grid-cols-2 gap-2 sm:grid-cols-2">
        <Tile
          label="SOC"
          icon="⚡"
          value={
            snapshot?.soc_pct != null
              ? `${Math.round(snapshot.soc_pct)}%`
              : loaded
                ? "—"
                : "…"
          }
        />
        <Tile
          label="Charge cycles"
          icon="🔋"
          value={
            snapshot?.charge_cycles != null
              ? snapshot.charge_cycles.toLocaleString("en-IN")
              : loaded
                ? "—"
                : "…"
          }
        />
        <Tile
          label="Temp stress 7d"
          icon="🌡"
          value={
            snapshot?.pack_temp_c != null
              ? `${Math.round(snapshot.pack_temp_c)}°C`
              : loaded
                ? "—"
                : "…"
          }
        />
        <Tile
          label="Last seen"
          icon="🕒"
          value={fmtLastSeen(snapshot?.last_seen ?? null)}
        />
      </section>

      <section className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-3">
        <p className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
          Warranty
        </p>
        {warranty ? (
          <ul className="mt-1 space-y-0.5 text-sm">
            <li>
              <span className="font-semibold">Status:</span>{" "}
              {warranty.status ?? "—"}
            </li>
            <li>
              <span className="font-semibold">Tenure:</span>{" "}
              {warranty.months != null ? `${warranty.months} months` : "—"}
            </li>
            {warranty.oem_expiry ? (
              <li>
                <span className="font-semibold">Expires:</span>{" "}
                {new Date(warranty.oem_expiry).toLocaleDateString("en-IN")}
              </li>
            ) : null}
          </ul>
        ) : (
          <p className="mt-1 text-sm italic text-[color:var(--color-ink-muted)]">
            No warranty record linked to this battery.
          </p>
        )}
      </section>
    </div>
  );
}

export default TelemetryTab;
