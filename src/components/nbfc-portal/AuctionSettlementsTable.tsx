"use client";

/**
 * E-039 — Post-auction settlement table (BRD §6.1.7)
 *
 * Renders the seller-tenant view of post-auction settlements. Each row shows
 * Lot ID, Final Price, Winner, Status, and last-updated timestamp. Allowed
 * status transitions (payment_pending → in_transit → delivered) are exposed
 * as an inline action button per row.
 */
import { useState, useTransition } from "react";

export type SettlementStatus =
  | "payment_pending"
  | "in_transit"
  | "delivered";

export interface SettlementRow {
  id: string;
  lot_id: string;
  final_price: number;
  winner_tenant_id: string;
  winner_name: string;
  status: SettlementStatus;
  updated_at: string;
}

interface AuctionSettlementsTableProps {
  rows: SettlementRow[];
}

const NEXT_STATUS: Record<SettlementStatus, SettlementStatus | null> = {
  payment_pending: "in_transit",
  in_transit: "delivered",
  delivered: null,
};

const STATUS_LABEL: Record<SettlementStatus, string> = {
  payment_pending: "Payment Pending",
  in_transit: "In Transit",
  delivered: "Delivered",
};

function fmtINR(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
}

export function AuctionSettlementsTable({
  rows,
}: AuctionSettlementsTableProps) {
  const [localRows, setLocalRows] = useState<SettlementRow[]>(rows);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function advanceStatus(row: SettlementRow) {
    const next = NEXT_STATUS[row.status];
    if (!next) return;
    setPendingId(row.id);
    setError(null);
    try {
      const res = await fetch(`/api/nbfc/auction/settlements/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const updated = await res.json();
      startTransition(() => {
        setLocalRows((prev) =>
          prev.map((r) =>
            r.id === row.id
              ? { ...r, status: updated.status, updated_at: updated.updated_at }
              : r,
          ),
        );
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingId(null);
    }
  }

  if (localRows.length === 0) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-dashed border-slate-300 rounded-lg p-12 text-center text-sm text-slate-500">
        No settlements yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800 text-left">
            <tr>
              <th className="px-3 py-2 font-medium">Lot ID</th>
              <th className="px-3 py-2 font-medium">Final Price</th>
              <th className="px-3 py-2 font-medium">Winner</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Updated</th>
              <th className="px-3 py-2 font-medium text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {localRows.map((row) => {
              const next = NEXT_STATUS[row.status];
              return (
                <tr
                  key={row.id}
                  className="border-t border-slate-200 dark:border-slate-700"
                >
                  <td className="px-3 py-2 font-mono text-xs">
                    {row.lot_id.slice(0, 8)}…
                  </td>
                  <td className="px-3 py-2">{fmtINR(row.final_price)}</td>
                  <td className="px-3 py-2">
                    {row.winner_name || row.winner_tenant_id.slice(0, 8)}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={
                        row.status === "delivered"
                          ? "rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800"
                          : row.status === "in_transit"
                            ? "rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800"
                            : "rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
                      }
                    >
                      {STATUS_LABEL[row.status]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-500">
                    {new Date(row.updated_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {next ? (
                      <button
                        type="button"
                        disabled={pendingId === row.id}
                        onClick={() => advanceStatus(row)}
                        className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                      >
                        {pendingId === row.id
                          ? "Updating…"
                          : `Mark ${STATUS_LABEL[next]}`}
                      </button>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
