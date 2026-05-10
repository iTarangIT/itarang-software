"use client";

/**
 * NbfcDirectory — list of NBFCs with status pills, CoR expiry hints, and
 * a CTA to onboard a new partner. Visual: BRD §6.B.
 *
 * Server component pre-fetches the rows (via Drizzle in the page file) and
 * passes them in. The directory itself is purely presentational.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowRight, Plus, Search } from "lucide-react";

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
  const [q, setQ] = useState("");

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
                {["NBFC", "Status", "RBI registration", "Partnership", "CoR expiry", ""].map(
                  (h) => (
                    <th
                      key={h}
                      className="px-5 py-3 text-[10px] font-bold uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] bg-[color:var(--color-bg)]/60 border-b border-[color:var(--color-border)]"
                    >
                      {h}
                    </th>
                  ),
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
                        {row.status}
                      </span>
                    </td>
                    <td className="px-5 py-4 font-mono text-[12px] text-[color:var(--color-ink)]">
                      {row.rbiRegistrationNo}
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
                    <td className="px-5 py-4 text-right">
                      <Link
                        href={`/admin/nbfc/${row.id}/review`}
                        className="inline-flex items-center gap-1 text-[color:var(--color-brand-sky)] font-semibold text-[13px] hover:underline"
                      >
                        Review
                        <ArrowRight className="w-3.5 h-3.5" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
