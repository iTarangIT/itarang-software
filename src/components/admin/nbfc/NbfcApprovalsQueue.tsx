"use client";

/**
 * NbfcApprovalsQueue — CEO-only queue of NBFCs in `pending_admin_review`.
 * Each row links into the existing /admin/nbfc/[id]/review page where the
 * branded NbfcFinalApprovalPanel lives. Visual: BRD §6.B.
 */
import Link from "next/link";
import { ArrowRight, ShieldCheck } from "lucide-react";

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
  DRAFT: "status-pill-neutral",
  EXPIRED: "status-pill-danger",
  FAILED: "status-pill-danger",
};

export default function NbfcApprovalsQueue({
  rows,
}: {
  rows: PendingNbfc[];
}) {
  if (rows.length === 0) {
    return (
      <div className="card-iTarang p-10 text-center space-y-3">
        <ShieldCheck
          className="w-10 h-10 mx-auto"
          style={{ color: "var(--color-brand-sky)" }}
        />
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
    <div className="card-iTarang overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr>
            {[
              "NBFC",
              "RBI registration",
              "Submitted",
              "Documents verified",
              "LSP agreement",
              "",
            ].map((h) => (
              <th
                key={h}
                className="px-5 py-3 text-left text-[10px] font-bold uppercase tracking-[0.14em] text-[color:var(--color-ink-muted)] bg-[color:var(--color-bg)]/60 border-b border-[color:var(--color-border)]"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const docsClass =
              row.verifiedDocsCount >= row.requiredDocsCount
                ? "text-[color:var(--color-success)]"
                : "text-[color:var(--color-warning)]";
            const lspToneClass = row.lspAgreementStatus
              ? LSP_TONE[row.lspAgreementStatus] ?? "status-pill-neutral"
              : "status-pill-neutral";
            return (
              <tr key={row.id} className="table-row-parcel">
                <td className="px-5 py-4">
                  <div className="font-semibold text-[color:var(--color-brand-navy)]">
                    {row.legalName}
                  </div>
                  <div className="text-[12px] font-mono text-[color:var(--color-ink-muted)] mt-0.5">
                    {row.nbfcId}
                  </div>
                </td>
                <td className="px-5 py-4 font-mono text-[12px]">
                  {row.rbiRegistrationNo}
                </td>
                <td className="px-5 py-4 text-[color:var(--color-ink-muted)]">
                  {row.submittedAt
                    ? new Date(row.submittedAt).toLocaleString()
                    : "—"}
                </td>
                <td className={`px-5 py-4 font-semibold ${docsClass}`}>
                  {row.verifiedDocsCount} / {row.requiredDocsCount}
                </td>
                <td className="px-5 py-4">
                  <span className={lspToneClass}>
                    {row.lspAgreementStatus ?? "MISSING"}
                  </span>
                </td>
                <td className="px-5 py-4 text-right">
                  <div className="inline-flex items-center gap-3">
                    <Link
                      href={`/admin/nbfc/${row.id}/kyc-review`}
                      className="inline-flex items-center gap-1 text-[color:var(--color-ink-muted)] font-semibold text-[13px] hover:text-[color:var(--color-brand-navy)] transition-colors"
                      data-testid={`nbfc-row-kyc-${row.id}`}
                    >
                      Run KYC
                    </Link>
                    <Link
                      href={`/admin/nbfc/${row.id}/review`}
                      className="inline-flex items-center gap-1 text-[color:var(--color-brand-sky)] font-semibold text-[13px] hover:underline"
                    >
                      Open Review
                      <ArrowRight className="w-3.5 h-3.5" />
                    </Link>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
