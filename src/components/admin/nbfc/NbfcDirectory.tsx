"use client";

/**
 * NbfcDirectory — list of NBFCs with status pills, CoR expiry hints, and
 * a CTA to onboard a new partner. Visual: BRD §6.B.
 *
 * Server component pre-fetches the rows (via Drizzle in the page file) and
 * passes them in. The directory itself is purely presentational.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowRight, Plus, Search, Trash2, X } from "lucide-react";
import { lspStatusToneClass } from "./lspStatusTone";

export interface NbfcRow {
  id: number;
  nbfcId: string;
  legalName: string;
  shortName: string;
  status: string;
  rbiRegistrationNo: string;
  partnershipDate: string | null;
  corExpiryDate: string | null; // YYYY-MM-DD
  createdAt: string | null;
  isMine: boolean;
  currentStepNumber: number;
  currentStepLabel: string;
  resumeUrl: string;
  lspAgreementStatus: string | null;
  lspSignerProgress: { signed: number; total: number } | null;
}

interface Props {
  rows: NbfcRow[];
  ownedFilter: boolean;
  viewerRole: string;
}

const STATUS_TONE: Record<string, string> = {
  draft: "status-pill-neutral",
  pending_admin_review: "status-pill-info",
  request_correction: "status-pill-warning",
  approved: "status-pill-info",
  active: "status-pill-success",
  rejected: "status-pill-danger",
  suspended: "status-pill-warning",
  terminated: "status-pill-danger",
};

// Display-only label remap. The DB enum stays `pending_admin_review` (so
// status-transitions, approval-gate, route guards, and history rows all
// keep working unchanged) but the UI surface shows the more accurate
// `pending_ceo_review` — it's the CEO doing the review after the admin
// submits.
const STATUS_LABEL: Record<string, string> = {
  pending_admin_review: "pending_ceo_review",
};

function daysToExpiry(yyyymmdd: string | null): number | null {
  if (!yyyymmdd) return null;
  const d = new Date(yyyymmdd + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}

export default function NbfcDirectory({
  rows,
  ownedFilter,
  viewerRole,
}: Props) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [pendingDelete, setPendingDelete] = useState<NbfcRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (ownedFilter && !r.isMine) return false;
      if (!term) return true;
      return (
        r.legalName.toLowerCase().includes(term) ||
        r.shortName.toLowerCase().includes(term) ||
        r.nbfcId.toLowerCase().includes(term) ||
        r.rbiRegistrationNo.toLowerCase().includes(term)
      );
    });
  }, [rows, q, ownedFilter]);

  const canOnboard = ["sales_head", "admin", "ceo", "business_head"].includes(
    viewerRole,
  );

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/admin/nbfc/${pendingDelete.id}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleteError(
          (typeof json?.message === "string" && json.message) ||
            (typeof json?.error === "string" && json.error) ||
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

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--color-ink-muted)]" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by NBFC name, ID, or RBI registration no…"
            className="input-itarang pl-10"
          />
        </div>
        {canOnboard && (
          <Link href="/admin/nbfc/new" className="btn-primary">
            <Plus className="w-4 h-4" />
            Onboard NBFC
          </Link>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="card-iTarang p-10 text-center">
          <p className="section-label-muted">No matches</p>
          <p className="text-sm text-[color:var(--color-ink-muted)] mt-2">
            {ownedFilter
              ? "You haven't submitted any NBFCs yet."
              : "Adjust your filters or onboard a new NBFC."}
          </p>
        </div>
      ) : (
        <div className="card-iTarang overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left">
                {["NBFC", "Status", "Step", "RBI registration", "LSP signing", "Partnership", "CoR expiry", ""].map(
                  (h, i, arr) => {
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
                  },
                )}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const days = daysToExpiry(row.corExpiryDate);
                const corClass =
                  days !== null && days <= 60
                    ? "status-pill-danger"
                    : "text-[color:var(--color-ink)]";
                return (
                  <tr
                    key={row.id}
                    className="table-row-parcel"
                  >
                    <td className="px-5 py-4">
                      <div className="font-semibold text-[color:var(--color-brand-navy)]">
                        {row.legalName}
                      </div>
                      <div className="text-[12px] font-mono text-[color:var(--color-ink-muted)] mt-0.5">
                        {row.nbfcId}
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <span
                        className={STATUS_TONE[row.status] ?? "status-pill-neutral"}
                      >
                        {STATUS_LABEL[row.status] ?? row.status}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-[13px] text-[color:var(--color-ink)] whitespace-nowrap">
                      <span className="font-semibold text-[color:var(--color-brand-navy)]">
                        Step {row.currentStepNumber}
                      </span>
                      <span className="mx-1.5 text-[color:var(--color-ink-muted)]">
                        ·
                      </span>
                      <span className="text-[color:var(--color-ink-muted)]">
                        {row.currentStepLabel}
                      </span>
                    </td>
                    <td className="px-5 py-4 font-mono text-[12px] text-[color:var(--color-ink)]">
                      {row.rbiRegistrationNo}
                    </td>
                    <td className="px-5 py-4">
                      {row.lspAgreementStatus ? (
                        <div className="flex flex-col items-start gap-1">
                          <span
                            className={lspStatusToneClass(row.lspAgreementStatus)}
                          >
                            {row.lspAgreementStatus}
                          </span>
                          {row.lspSignerProgress &&
                            row.lspAgreementStatus !==
                              "PENDING_CEO_VERIFICATION" && (
                              <span className="text-[11px] text-[color:var(--color-ink-muted)] font-mono">
                                Signed {row.lspSignerProgress.signed}/
                                {row.lspSignerProgress.total}
                              </span>
                            )}
                        </div>
                      ) : (
                        <span className="text-[color:var(--color-ink-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-5 py-4 text-[color:var(--color-ink-muted)]">
                      {row.partnershipDate ?? "—"}
                    </td>
                    <td className="px-5 py-4">
                      {row.corExpiryDate ? (
                        <span className={corClass}>
                          {row.corExpiryDate}
                          {days !== null && days <= 60 && (
                            <span className="ml-2 text-[11px] font-semibold">
                              {days < 0 ? "EXPIRED" : `${days}d`}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-[color:var(--color-ink-muted)]">—</span>
                      )}
                    </td>
                    <td className="pl-5 pr-8 py-4 text-right whitespace-nowrap min-w-[160px]">
                      <div className="inline-flex items-center gap-2">
                        <Link
                          href={row.resumeUrl}
                          className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-[13px] font-semibold text-white transition-all shadow-sm hover:shadow-md hover:-translate-y-0.5"
                          style={{
                            background: "var(--color-brand-sky)",
                          }}
                        >
                          Review
                          <ArrowRight className="w-3.5 h-3.5" />
                        </Link>
                        {row.status === "active" && !ownedFilter && (
                          <Link
                            href={`/admin/nbfc/${row.id}/loan-products`}
                            className="inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-[13px] font-semibold transition-all border hover:bg-[color:var(--color-bg)]"
                            style={{
                              color: "var(--color-brand-navy)",
                              borderColor: "var(--color-border)",
                            }}
                          >
                            Add loan products
                          </Link>
                        )}
                        {/* Always reserve the trash icon's slot so the
                            Review pill sits at the same right offset on
                            every row. Without this, non-draft rows had no
                            trash icon and the Review pill drifted right
                            into the card's rounded corner where it got
                            clipped. */}
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteError(null);
                            setPendingDelete(row);
                          }}
                          aria-label={`Delete draft ${row.legalName}`}
                          title="Delete draft"
                          aria-hidden={!(row.isMine && row.status === "draft")}
                          tabIndex={
                            row.isMine && row.status === "draft" ? 0 : -1
                          }
                          className={`inline-flex items-center justify-center w-8 h-8 rounded-md text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger-bg,rgba(220,38,38,0.08))] transition-colors ${
                            row.isMine && row.status === "draft"
                              ? ""
                              : "invisible pointer-events-none"
                          }`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-nbfc-title"
        >
          <div className="card-iTarang max-w-md w-full p-6 space-y-4 bg-[color:var(--color-bg)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="section-label-muted">Delete draft NBFC</p>
                <h2
                  id="delete-nbfc-title"
                  className="text-lg font-semibold text-[color:var(--color-brand-navy)] mt-1"
                >
                  {pendingDelete.legalName}
                </h2>
                <p className="text-[12px] font-mono text-[color:var(--color-ink-muted)] mt-0.5">
                  {pendingDelete.nbfcId}
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
              This will permanently remove the master record, uploaded
              compliance documents, directors, and status history. This
              cannot be undone.
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
                {deleting ? "Deleting…" : "Delete draft"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
