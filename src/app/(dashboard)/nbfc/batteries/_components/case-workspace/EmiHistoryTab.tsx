"use client";

import { useEffect, useState } from "react";

interface EmiRow {
  id: string;
  due_date: string;
  paid_at: string | null;
  status: string;
  days_overdue: number | null;
}

function statusPill(status: string, daysOverdue: number | null) {
  const v = status.toLowerCase();
  if (v === "paid") {
    return (
      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
        Paid
      </span>
    );
  }
  if (v === "overdue" || (daysOverdue ?? 0) > 0) {
    return (
      <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700">
        Overdue{daysOverdue ? ` · ${daysOverdue}d` : ""}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
      {status}
    </span>
  );
}

export function EmiHistoryTab({ loanSanctionId }: { loanSanctionId: string }) {
  const [items, setItems] = useState<EmiRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/nbfc/loans/${encodeURIComponent(loanSanctionId)}/emi-schedule`,
          { cache: "no-store" },
        );
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
          setItems([]);
          return;
        }
        setItems(Array.isArray(body.items) ? body.items : []);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setItems([]);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [loanSanctionId]);

  if (items === null) {
    return (
      <p className="p-4 text-sm italic text-[color:var(--color-ink-muted)]">
        Loading EMI schedule…
      </p>
    );
  }

  if (items.length === 0) {
    return (
      <div className="space-y-2">
        {error ? (
          <p className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            {error}
          </p>
        ) : null}
        <p className="rounded border border-dashed border-[color:var(--color-border)] p-4 text-sm italic text-[color:var(--color-ink-muted)]">
          No EMI schedule rows for this loan.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-[color:var(--color-border)]">
      <table className="w-full text-sm">
        <thead className="bg-[color:var(--color-surface-muted)] text-left text-[10px] uppercase tracking-widest text-[color:var(--color-ink-muted)]">
          <tr>
            <th className="px-3 py-2">Due date</th>
            <th className="px-3 py-2">Paid at</th>
            <th className="px-3 py-2 text-right">Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr
              key={r.id}
              className="border-t border-[color:var(--color-border)]"
            >
              <td className="px-3 py-2 tabular-nums">
                {new Date(r.due_date).toLocaleDateString("en-IN")}
              </td>
              <td className="px-3 py-2 tabular-nums text-[color:var(--color-ink-muted)]">
                {r.paid_at
                  ? new Date(r.paid_at).toLocaleDateString("en-IN")
                  : "—"}
              </td>
              <td className="px-3 py-2 text-right">
                {statusPill(r.status, r.days_overdue)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default EmiHistoryTab;
