"use client";

import { useEffect, useState } from "react";

interface DayPoint {
  date: string;
  value: number | null;
}

export function UsagePatternTab({
  serialNumber,
}: {
  serialNumber: string | null;
}) {
  const [points, setPoints] = useState<DayPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serialNumber) {
      setPoints([]);
      return;
    }
    let cancelled = false;
    async function load(serial: string) {
      try {
        const url = new URL(
          `/api/nbfc/iot/battery/${encodeURIComponent(serial)}/history`,
          window.location.origin,
        );
        url.searchParams.set("metric", "daily_km");
        const to = new Date();
        const from = new Date();
        from.setDate(from.getDate() - 30);
        url.searchParams.set("from", from.toISOString().slice(0, 10));
        url.searchParams.set("to", to.toISOString().slice(0, 10));
        const res = await fetch(url.toString(), { cache: "no-store" });
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
          setPoints([]);
          return;
        }
        setPoints(Array.isArray(body.points) ? body.points : []);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setPoints([]);
      }
    }
    load(serialNumber);
    return () => {
      cancelled = true;
    };
  }, [serialNumber]);

  if (points === null) {
    return (
      <p className="p-4 text-sm italic text-[color:var(--color-ink-muted)]">
        Loading usage…
      </p>
    );
  }

  const numeric = points.filter(
    (p) => typeof p.value === "number" && Number.isFinite(p.value),
  );
  const avgKm =
    numeric.length === 0
      ? null
      : numeric.reduce((a, b) => a + (b.value as number), 0) / numeric.length;
  const idleDays = points.filter(
    (p) => p.value == null || p.value === 0,
  ).length;

  if (numeric.length === 0) {
    return (
      <div className="space-y-2">
        {error ? (
          <p className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            {error}
          </p>
        ) : null}
        <p className="rounded border border-dashed border-[color:var(--color-border)] p-4 text-sm italic text-[color:var(--color-ink-muted)]">
          No daily-km history available for this battery.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
            Avg km/day (30d)
          </p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {avgKm != null ? avgKm.toFixed(1) : "—"} km
          </p>
        </div>
        <div className="rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
            Idle days (30d)
          </p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {idleDays} / {points.length}
          </p>
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-[color:var(--color-border)]">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-surface-muted)] text-left text-[10px] uppercase tracking-widest text-[color:var(--color-ink-muted)]">
            <tr>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2 text-right">Km</th>
            </tr>
          </thead>
          <tbody>
            {points.slice(-10).reverse().map((p) => (
              <tr
                key={p.date}
                className="border-t border-[color:var(--color-border)]"
              >
                <td className="px-3 py-2 tabular-nums">
                  {new Date(p.date).toLocaleDateString("en-IN")}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {p.value != null ? Number(p.value).toFixed(1) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default UsagePatternTab;
