"use client";

/**
 * E-039 — Post-auction settlement table (BRD §6.1.7)
 *
 * The seller's view of what they have sold and where each sale has got to.
 *
 * WHAT CHANGED
 *   The winner column used to read a single name resolved by an INNER JOIN on
 *   `nbfc_tenants.id = winner_tenant_id`. Since the E-232 bidder re-point every
 *   winner is a DEALER, and on a dealer win that column carries the SELLER's
 *   tenant — so the column showed the seller their own name as the buyer, or
 *   dropped the row entirely. The row now carries `winner_kind` and the dealer
 *   id, and says which kind of party it is showing.
 *
 *   It also renders as cards below the auction theme's 60rem line instead of a
 *   table in a horizontal scroller, and drops the `dark:` classes, which are
 *   inert app-wide (globals.css maps the dark variant to a selector that never
 *   matches).
 */
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

export type SettlementStatus = "payment_pending" | "in_transit" | "delivered";

export interface SettlementRow {
  id: string;
  /** Kept as the display code the seller recognises, not the uuid. */
  lot_id: string;
  lot_code?: string;
  final_price: number;
  winner_tenant_id: string;
  winner_dealer_id?: string | null;
  winner_name: string;
  winner_kind?: "dealer" | "nbfc";
  status: SettlementStatus;
  updated_at: string;
  /** E-249. Present once money has actually been captured. */
  paid_at?: string | null;
  payment_ref?: string | null;
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
  payment_pending: "Payment pending",
  in_transit: "In transit",
  delivered: "Delivered",
};

const STATUS_TONE: Record<SettlementStatus, string> = {
  payment_pending: "muted",
  in_transit: "warn",
  delivered: "live",
};

function fmtINR(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("en-IN");
}

export function AuctionSettlementsTable({
  rows,
}: AuctionSettlementsTableProps) {
  const [localRows, setLocalRows] = useState<SettlementRow[]>(rows);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // The page is a server component: a refresh hands down new rows and the local
  // copy must follow, or an optimistic update from a previous render sticks.
  useEffect(() => setLocalRows(rows), [rows]);

  async function advanceStatus(row: SettlementRow) {
    const next = NEXT_STATUS[row.status];
    if (!next) return;
    setPendingId(row.id);
    try {
      const res = await fetch(`/api/nbfc/auction/settlements/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      startTransition(() => {
        setLocalRows((prev) =>
          prev.map((r) =>
            r.id === row.id
              ? { ...r, status: body.status, updated_at: body.updated_at }
              : r,
          ),
        );
      });
      toast.success(`Marked ${STATUS_LABEL[next].toLowerCase()}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingId(null);
    }
  }

  if (localRows.length === 0) {
    return (
      <div className="auction-sheet">
        <div className="auc-empty">
          <p>No settlements yet.</p>
          <p className="auc-empty-hint">
            A settlement opens automatically when a lot closes above its reserve
            and the winning bid is approved.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="auction-sheet">
      {/* Desktop: the ledger table. */}
      <div className="auc-only-wide auc-scroll-x">
        <table className="auc-table">
          <thead>
            <tr>
              <th>Lot</th>
              <th className="auc-num">Final price</th>
              <th>Winner</th>
              <th>Status</th>
              <th>Updated</th>
              <th className="auc-num">Action</th>
            </tr>
          </thead>
          <tbody>
            {localRows.map((row) => {
              const next = NEXT_STATUS[row.status];
              return (
                <tr key={row.id}>
                  <td>
                    <span className="auc-lotcode">
                      {row.lot_code ?? row.lot_id}
                    </span>
                  </td>
                  <td className="auc-num">{fmtINR(row.final_price)}</td>
                  <td>
                    <div className="auc-winner">
                      <span>{row.winner_name || "—"}</span>
                      <span
                        className="auc-chip"
                        data-tone={
                          row.winner_kind === "nbfc" ? "muted" : "live"
                        }
                      >
                        {row.winner_kind === "nbfc" ? "NBFC" : "Dealer"}
                      </span>
                    </div>
                  </td>
                  <td>
                    <span
                      className="auc-chip"
                      data-tone={STATUS_TONE[row.status]}
                    >
                      {STATUS_LABEL[row.status]}
                    </span>
                    {row.paid_at ? (
                      <div className="auc-subtle">
                        paid {fmtWhen(row.paid_at)}
                      </div>
                    ) : null}
                  </td>
                  <td className="auc-subtle">{fmtWhen(row.updated_at)}</td>
                  <td className="auc-num">
                    {next ? (
                      <button
                        type="button"
                        className="auc-btn"
                        data-variant="ghost"
                        disabled={pendingId === row.id}
                        onClick={() => advanceStatus(row)}
                      >
                        {pendingId === row.id
                          ? "Updating…"
                          : `Mark ${STATUS_LABEL[next].toLowerCase()}`}
                      </button>
                    ) : (
                      <span className="auc-subtle">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile: one card per settlement. A six-column ledger in a horizontal
          scroller is unreadable on a phone. */}
      <div className="auc-only-narrow auc-stack">
        {localRows.map((row) => {
          const next = NEXT_STATUS[row.status];
          return (
            <article key={row.id} className="auc-mini-card">
              <header>
                <span className="auc-lotcode">
                  {row.lot_code ?? row.lot_id}
                </span>
                <span className="auc-chip" data-tone={STATUS_TONE[row.status]}>
                  {STATUS_LABEL[row.status]}
                </span>
              </header>
              <dl className="auc-dl">
                <div>
                  <dt>Final price</dt>
                  <dd>{fmtINR(row.final_price)}</dd>
                </div>
                <div>
                  <dt>Winner</dt>
                  <dd>
                    {row.winner_name || "—"}
                    <span className="auc-subtle">
                      {row.winner_kind === "nbfc" ? " · NBFC" : " · Dealer"}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>{fmtWhen(row.updated_at)}</dd>
                </div>
                {row.paid_at ? (
                  <div>
                    <dt>Paid</dt>
                    <dd>{fmtWhen(row.paid_at)}</dd>
                  </div>
                ) : null}
              </dl>
              {next ? (
                <button
                  type="button"
                  className="auc-btn"
                  disabled={pendingId === row.id}
                  onClick={() => advanceStatus(row)}
                >
                  {pendingId === row.id
                    ? "Updating…"
                    : `Mark ${STATUS_LABEL[next].toLowerCase()}`}
                </button>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}

export default AuctionSettlementsTable;
