"use client";

/**
 * LoanProductsDirectory — global, searchable catalogue of every NBFC loan
 * product. Server component pre-fetches the rows (Drizzle in the page file)
 * and passes them in; this component is purely presentational + client-side
 * filtering (search by product name, plus an active/inactive status filter).
 *
 * Each row shows the owning NBFC's NAME (never the raw numeric nbfc_id) and an
 * Edit action that deep-links to the per-product edit screen.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Pencil, Search, Trash2, X } from "lucide-react";

export interface LoanProductRow {
  id: number;
  productName: string;
  nbfcName: string;
  status: string;
  batteryCategories: string[];
  loanAmountMin: number;
  loanAmountMax: number;
  minRoiPct: string;
  maxRoiPct: string;
}

interface Props {
  rows: LoanProductRow[];
}

const STATUS_TONE: Record<string, string> = {
  active: "status-pill-success",
  inactive: "status-pill-neutral",
};

type StatusFilter = "all" | "active" | "inactive";

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export default function LoanProductsDirectory({ rows }: Props) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [pendingDelete, setPendingDelete] = useState<LoanProductRow | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(
        `/api/admin/nbfc/loan-products/${pendingDelete.id}`,
        { method: "DELETE" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleteError(
          (typeof json?.message === "string" && json.message) ||
            `Delete failed (HTTP ${res.status})`,
        );
        setDeleting(false);
        return;
      }
      setDeleting(false);
      setPendingDelete(null);
      router.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Network error");
      setDeleting(false);
    }
  }

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (!term) return true;
      // Primary search is by loan product name; NBFC name is matched too so a
      // partner-scoped search still works.
      return (
        r.productName.toLowerCase().includes(term) ||
        r.nbfcName.toLowerCase().includes(term)
      );
    });
  }, [rows, q, statusFilter]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--color-ink-muted)]" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by loan product name…"
            className="input-itarang pl-10"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="input-itarang sm:w-44 shrink-0"
          aria-label="Filter by status"
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="card-iTarang p-10 text-center">
          <p className="section-label-muted">No matches</p>
          <p className="text-sm text-[color:var(--color-ink-muted)] mt-2">
            {rows.length === 0
              ? "No loan products have been created yet. Add one from the NBFC Directory."
              : "Adjust your search or status filter."}
          </p>
        </div>
      ) : (
        <div className="card-iTarang overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-sm">
              <thead>
                <tr className="text-left">
                  {[
                    "Loan product",
                    "NBFC",
                    "Battery",
                    "Loan amount",
                    "ROI",
                    "Status",
                    "",
                  ].map((h, i, arr) => {
                    const isActions = i === arr.length - 1;
                    return (
                      <th
                        key={h || "actions"}
                        className={`py-3 text-[10px] font-bold uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] bg-[color:var(--color-bg)]/60 border-b border-[color:var(--color-border)] ${
                          isActions ? "pl-5 pr-8 min-w-[160px]" : "px-5"
                        }`}
                      >
                        {h}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={row.id} className="table-row-parcel">
                    <td className="px-5 py-4 min-w-[200px]">
                      <div className="font-semibold text-[color:var(--color-brand-navy)]">
                        {row.productName}
                      </div>
                    </td>
                    <td className="px-5 py-4 text-[color:var(--color-ink)]">
                      {row.nbfcName}
                    </td>
                    <td className="px-5 py-4 text-[12px] text-[color:var(--color-ink-muted)] whitespace-nowrap">
                      {row.batteryCategories.length
                        ? row.batteryCategories.join(", ")
                        : "—"}
                    </td>
                    <td className="px-5 py-4 text-[color:var(--color-ink)] whitespace-nowrap">
                      {rupees(row.loanAmountMin)} – {rupees(row.loanAmountMax)}
                    </td>
                    <td className="px-5 py-4 text-[color:var(--color-ink)] whitespace-nowrap">
                      {row.minRoiPct}% – {row.maxRoiPct}%
                    </td>
                    <td className="px-5 py-4">
                      <span
                        className={
                          STATUS_TONE[row.status] ?? "status-pill-neutral"
                        }
                      >
                        {row.status}
                      </span>
                    </td>
                    <td className="pl-5 pr-8 py-4 text-right whitespace-nowrap min-w-[160px]">
                      <div className="inline-flex items-center gap-2">
                        <Link
                          href={`/admin/loan-products/${row.id}/edit`}
                          className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-[13px] font-semibold transition-all border hover:bg-[color:var(--color-bg)]"
                          style={{
                            color: "var(--color-brand-navy)",
                            borderColor: "var(--color-border)",
                          }}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                          Edit
                        </Link>
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteError(null);
                            setPendingDelete(row);
                          }}
                          aria-label={`Delete ${row.productName}`}
                          title="Delete loan product"
                          className="inline-flex items-center justify-center w-8 h-8 rounded-md text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger-bg,rgba(220,38,38,0.08))] transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-loan-product-title"
        >
          <div className="card-iTarang max-w-md w-full p-6 space-y-4 bg-[color:var(--color-bg)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="section-label-muted">Delete loan product</p>
                <h2
                  id="delete-loan-product-title"
                  className="text-lg font-semibold text-[color:var(--color-brand-navy)] mt-1"
                >
                  {pendingDelete.productName}
                </h2>
                <p className="text-[12px] text-[color:var(--color-ink-muted)] mt-0.5">
                  {pendingDelete.nbfcName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!deleting) {
                    setPendingDelete(null);
                    setDeleteError(null);
                  }
                }}
                aria-label="Close"
                className="text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-sm text-[color:var(--color-ink)]">
              This permanently removes the product from the catalogue and from
              dealer Section G. This cannot be undone. If the product is already
              assigned to a lead, delete is blocked — set its status to Inactive
              instead.
            </p>
            {deleteError && (
              <div
                className="card-iTarang p-3 text-[13px]"
                style={{
                  color: "var(--color-danger)",
                  borderColor: "var(--color-danger)",
                }}
              >
                {deleteError}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setPendingDelete(null);
                  setDeleteError(null);
                }}
                disabled={deleting}
                className="btn-ghost"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deleting}
                className="btn-primary"
                style={{
                  background: "var(--color-danger)",
                  borderColor: "var(--color-danger)",
                }}
              >
                {deleting ? "Deleting…" : "Delete product"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
