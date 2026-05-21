"use client";

/**
 * NbfcApprovalsQueue — CEO-only queue of NBFCs in `pending_admin_review`.
 * Each row links into the existing /admin/nbfc/[id]/review page where the
 * branded NbfcFinalApprovalPanel lives. Visual: BRD §6.B.
 */
import Link from "next/link";
import { ArrowRight, Building2, CheckCircle2, FileCheck2, ShieldCheck } from "lucide-react";

export interface PendingNbfc {
  id: number;
  nbfcId: string;
  legalName: string;
  rbiRegistrationNo: string;
  submittedAt: string | null;
  verifiedDocsCount: number;
  requiredDocsCount: number;
  lspAgreementStatus: string | null;
}

const LSP_TONE: Record<string, string> = {
  COMPLETED: "status-pill-success",
  SENT_TO_EXTERNAL_PARTY: "status-pill-info",
  IN_PROGRESS: "status-pill-info",
  PENDING_CEO_VERIFICATION: "status-pill-info",
  DRAFT: "status-pill-neutral",
  EXPIRED: "status-pill-danger",
  FAILED: "status-pill-danger",
};

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function NbfcApprovalsQueue({
  rows,
}: {
  rows: PendingNbfc[];
}) {
  if (rows.length === 0) {
    return (
      <div className="card-iTarang p-12 text-center space-y-3">
        <div
          className="inline-flex items-center justify-center w-14 h-14 rounded-2xl"
          style={{
            background: "var(--color-info-bg)",
          }}
        >
          <ShieldCheck
            className="w-7 h-7"
            style={{ color: "var(--color-brand-sky)" }}
          />
        </div>
        <p className="section-label-muted">All clear</p>
        <h3 className="text-lg font-semibold text-[color:var(--color-brand-navy)]">
          No NBFCs awaiting your approval
        </h3>
        <p className="text-sm text-[color:var(--color-ink-muted)] max-w-md mx-auto">
          Sales-head submissions land here once compliance documents are
          uploaded and the LSP agreement is initiated.
        </p>
      </div>
    );
  }

  return (
    <div
      className="card-iTarang overflow-hidden"
      style={{
        boxShadow:
          "0 1px 2px rgba(15, 23, 42, 0.04), 0 12px 32px -16px rgba(15, 23, 42, 0.16)",
      }}
    >
      <div
        className="flex items-center justify-between gap-4 px-6 py-4 border-b"
        style={{
          background:
            "linear-gradient(180deg, var(--color-bg) 0%, transparent 100%)",
          borderColor: "var(--color-border)",
        }}
      >
        <div className="flex items-center gap-2 text-[color:var(--color-brand-navy)]">
          <FileCheck2 className="w-4 h-4" />
          <span className="text-sm font-semibold">Review queue</span>
        </div>
        <span
          className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.14em] px-2.5 py-1 rounded-full"
          style={{
            background: "var(--color-info-bg)",
            color: "var(--color-brand-sky)",
          }}
        >
          {rows.length} pending
        </span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr>
            {[
              "NBFC",
              "RBI registration",
              "Submitted",
              "Documents verified",
              "Agreement status",
              "",
            ].map((h, i, arr) => {
              const isActions = i === arr.length - 1;
              return (
                <th
                  key={h || "actions"}
                  className={`py-3 text-left text-[10px] font-bold uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] bg-[color:var(--color-bg)]/60 border-b border-[color:var(--color-border)] ${
                    isActions ? "pl-5 pr-8 min-w-[160px] text-right" : "px-5"
                  }`}
                >
                  {h}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const docsComplete = row.verifiedDocsCount >= row.requiredDocsCount;
            const docsClass = docsComplete
              ? "text-[color:var(--color-success)]"
              : "text-[color:var(--color-warning)]";
            const lspToneClass = row.lspAgreementStatus
              ? LSP_TONE[row.lspAgreementStatus] ?? "status-pill-neutral"
              : "status-pill-neutral";
            return (
              <tr key={row.id} className="table-row-parcel">
                <td className="px-5 py-4">
                  <div className="flex items-start gap-3">
                    <div
                      className="inline-flex items-center justify-center w-9 h-9 rounded-lg shrink-0"
                      style={{
                        background: "var(--color-info-bg)",
                        color: "var(--color-brand-sky)",
                      }}
                    >
                      <Building2 className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-[color:var(--color-brand-navy)] truncate">
                        {row.legalName}
                      </div>
                      <div className="text-[12px] font-mono text-[color:var(--color-ink-muted)] mt-0.5">
                        {row.nbfcId}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-5 py-4 font-mono text-[12px] text-[color:var(--color-ink)]">
                  {row.rbiRegistrationNo}
                </td>
                <td className="px-5 py-4 text-[13px] text-[color:var(--color-ink-muted)] whitespace-nowrap">
                  {formatRelative(row.submittedAt)}
                </td>
                <td className="px-5 py-4">
                  <span
                    className={`inline-flex items-center gap-1.5 text-[13px] font-bold font-mono ${docsClass}`}
                  >
                    {docsComplete && <CheckCircle2 className="w-3.5 h-3.5" />}
                    {row.verifiedDocsCount} / {row.requiredDocsCount}
                  </span>
                </td>
                <td className="px-5 py-4">
                  <span className={lspToneClass}>
                    {row.lspAgreementStatus ?? "MISSING"}
                  </span>
                </td>
                <td className="pl-5 pr-8 py-4 text-right whitespace-nowrap min-w-[160px]">
                  <Link
                    href={`/admin/nbfc/${row.id}/review`}
                    className="inline-flex items-center gap-1.5 px-3.5 h-8 rounded-lg text-[13px] font-semibold text-white transition-all shadow-sm hover:shadow-md hover:-translate-y-0.5"
                    style={{
                      background: "var(--color-brand-sky)",
                    }}
                  >
                    Open Review
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
