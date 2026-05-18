"use client";

/**
 * E-112 — Post-approval signing status panel.
 *
 * Surfaces per-signer Digio status (sent → signed → completed / failed /
 * expired) along with download buttons for the signed PDF + audit trail once
 * the agreement reaches COMPLETED. Visible on both the admin /approval and
 * CEO /review pages; both roles can download.
 *
 * Data is server-rendered (the parent page reads nbfcLspAgreements +
 * nbfcLspAgreementSigners and passes them in); a small client hook polls
 * /approval-readiness so the badge counts stay live while the webhook is
 * trickling in events.
 */
import { useState } from "react";
import {
  CheckCircle2,
  Clock,
  Download,
  FileSignature,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";

export interface SignerStatusRow {
  id: number;
  signer_order: number;
  party: "nbfc" | "itarang";
  full_name: string;
  email: string;
  designation: string;
  signing_status: string;
  signed_at: string | null;
}

export interface SignerStatusPanelAgreement {
  id: number;
  agreement_status: string | null;
  signed_pdf_url: string | null;
  audit_trail_url: string | null;
  digio_document_id: string | null;
  completed_at: string | null;
}

interface Props {
  nbfcId: number;
  agreement: SignerStatusPanelAgreement | null;
  signers: SignerStatusRow[];
  /** When true, render a Resend button that calls POST /lsp-agreement/resend. */
  canResend?: boolean;
}

function statusBadge(status: string) {
  const s = status.toLowerCase();
  if (s === "signed") {
    return {
      label: "Signed",
      icon: <CheckCircle2 className="w-3.5 h-3.5" />,
      className: "status-pill-success",
    };
  }
  if (s === "sent" || s === "pending") {
    return {
      label: s === "sent" ? "Sent" : "Pending",
      icon: <Clock className="w-3.5 h-3.5" />,
      className: "status-pill-info",
    };
  }
  if (s === "failed" || s === "declined") {
    return {
      label: s === "declined" ? "Declined" : "Failed",
      icon: <XCircle className="w-3.5 h-3.5" />,
      className: "status-pill-danger",
    };
  }
  if (s === "expired") {
    return {
      label: "Expired",
      icon: <Clock className="w-3.5 h-3.5" />,
      className: "status-pill-warning",
    };
  }
  return {
    label: status,
    icon: <Clock className="w-3.5 h-3.5" />,
    className: "status-pill-neutral",
  };
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function NbfcLspSignerStatusPanel({
  nbfcId,
  agreement,
  signers,
  canResend = false,
}: Props) {
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
  const [resendOk, setResendOk] = useState(false);

  if (!agreement) {
    return null;
  }

  const status = agreement.agreement_status ?? "PENDING_CEO_VERIFICATION";
  // Panel renders for every agreement state — admin and CEO both need to see
  // the signer list, parties, designations, and per-signer status the moment
  // the agreement bundle is created. Download bar still gates on COMPLETED.
  const isPreSent = status === "PENDING_CEO_VERIFICATION" || status === "DRAFT";

  const signedCount = signers.filter(
    (s) => s.signing_status.toLowerCase() === "signed",
  ).length;
  const totalCount = signers.length;
  const allSigned = totalCount > 0 && signedCount === totalCount;
  const isCompleted = status === "COMPLETED";
  const isExpired = status === "EXPIRED";
  const isFailed = status === "FAILED";

  async function onResend() {
    setResending(true);
    setResendError(null);
    setResendOk(false);
    try {
      const res = await fetch(
        `/api/admin/nbfc/${nbfcId}/lsp-agreement/resend`,
        { method: "POST", headers: { "content-type": "application/json" } },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResendError(
          (body as { message?: string; error?: string }).message ??
            (body as { error?: string }).error ??
            `Resend failed (${res.status})`,
        );
      } else {
        setResendOk(true);
      }
    } catch (err) {
      setResendError(err instanceof Error ? err.message : String(err));
    } finally {
      setResending(false);
    }
  }

  return (
    <section
      data-testid="nbfc-lsp-signer-status-panel"
      className="card-iTarang p-6 space-y-5"
    >
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <p className="section-label">Signing status</p>
          <h2 className="text-lg font-semibold text-[color:var(--color-brand-navy)]">
            LSP agreement — Digio Aadhaar e-sign
          </h2>
          <p className="text-xs text-[color:var(--color-ink-muted)]">
            {isCompleted
              ? `All ${totalCount} signers have signed. Signed agreement and audit trail are available below.`
              : isPreSent
                ? `${totalCount} signer${totalCount === 1 ? "" : "s"} configured. Digio will email signer 1 the moment the CEO approves the agreement.`
                : `${signedCount} of ${totalCount} signers have signed. Digio emails the next signer in order once the previous one completes.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            data-testid="agreement-status-pill"
            className={
              isCompleted
                ? "status-pill-success"
                : isFailed
                  ? "status-pill-danger"
                  : isExpired
                    ? "status-pill-warning"
                    : "status-pill-info"
            }
          >
            {status}
          </span>
        </div>
      </header>

      {signers.length === 0 && (
        <p className="text-xs text-[color:var(--color-ink-muted)] rounded-xl px-4 py-3 border border-dashed border-[color:var(--color-border)]">
          No signers have been added yet. The admin configures NBFC and iTarang signers on the Agreement step.
        </p>
      )}

      <ol className="space-y-2">
        {signers.map((s) => {
          const badge = statusBadge(s.signing_status);
          return (
            <li
              key={s.id}
              data-testid={`signer-row-${s.id}`}
              className="flex items-center gap-4 rounded-xl border border-[color:var(--color-border)] px-4 py-3"
            >
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0"
                style={{
                  background:
                    s.party === "nbfc"
                      ? "var(--brand-sky-soft)"
                      : "var(--brand-teal-soft)",
                  color:
                    s.party === "nbfc"
                      ? "var(--color-brand-sky)"
                      : "var(--color-brand-teal)",
                }}
              >
                {s.signer_order}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-[color:var(--color-brand-navy)] truncate">
                  {s.full_name}
                </p>
                <p className="text-xs text-[color:var(--color-ink-muted)] truncate">
                  {s.designation} · {s.email} ·{" "}
                  {s.party === "nbfc" ? "NBFC" : "iTarang"}
                </p>
              </div>
              <div className="flex flex-col items-end gap-0.5 shrink-0">
                <span
                  className={`inline-flex items-center gap-1 ${badge.className}`}
                >
                  {badge.icon}
                  {badge.label}
                </span>
                <span className="text-[11px] text-[color:var(--color-ink-muted)]">
                  {formatTimestamp(s.signed_at)}
                </span>
              </div>
            </li>
          );
        })}
      </ol>

      {/* Download bar — shown unconditionally once the agreement is
          COMPLETED. The href points at our server proxy
          (/api/admin/nbfc/{id}/lsp-agreement/{signed-pdf|audit-trail}),
          which fetches from Digio (or the on-disk cache) on each click
          and streams a real PDF back. No URL-presence gate, no spinner. */}
      {isCompleted && (
        <div className="pt-4 border-t border-[color:var(--color-border)] space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-ink-muted)]">
              Documents
            </p>
            {agreement.completed_at && (
              <span
                className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full"
                style={{
                  background: "var(--color-success-bg)",
                  color: "var(--color-success)",
                }}
              >
                <CheckCircle2 className="w-3 h-3" />
                Completed {formatTimestamp(agreement.completed_at)}
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <a
              data-testid="download-signed-agreement"
              href={`/api/admin/nbfc/${nbfcId}/lsp-agreement/signed-pdf`}
              download={`lsp-agreement-${nbfcId}.pdf`}
              className="group flex items-center gap-3 h-14 px-4 rounded-xl text-white font-semibold transition-all shadow-md hover:shadow-lg hover:-translate-y-0.5"
              style={{
                background:
                  "linear-gradient(135deg, var(--color-brand-navy) 0%, var(--color-brand-sky) 100%)",
              }}
            >
              <span
                className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center"
                style={{ background: "rgba(255,255,255,0.18)" }}
              >
                <FileSignature className="w-5 h-5" />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm leading-tight">
                  Download signed agreement
                </span>
                <span className="block text-[11px] font-normal opacity-85">
                  Final PDF with all signatures
                </span>
              </span>
              <Download className="w-4 h-4 shrink-0 opacity-80 group-hover:opacity-100 group-hover:translate-y-0.5 transition-transform" />
            </a>
            <a
              data-testid="download-audit-trail"
              href={`/api/admin/nbfc/${nbfcId}/lsp-agreement/audit-trail`}
              download={`lsp-audit-trail-${nbfcId}.pdf`}
              className="group flex items-center gap-3 h-14 px-4 rounded-xl font-semibold transition-all border-2"
              style={{
                background: "var(--brand-sky-soft, rgba(19,143,198,0.08))",
                borderColor: "var(--color-brand-sky)",
                color: "var(--color-brand-navy)",
              }}
            >
              <span
                className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center"
                style={{
                  background: "var(--color-brand-sky)",
                  color: "#fff",
                }}
              >
                <Download className="w-5 h-5" />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm leading-tight">
                  Download audit trail
                </span>
                <span className="block text-[11px] font-normal opacity-75">
                  Digio compliance audit log
                </span>
              </span>
              <Download className="w-4 h-4 shrink-0 opacity-70 group-hover:opacity-100 group-hover:translate-y-0.5 transition-transform" />
            </a>
          </div>
        </div>
      )}

      {/* Resend bar — admin/CEO can re-fire Digio if expired or failed. */}
      {canResend && (isExpired || isFailed) && (
        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-[color:var(--color-border)]">
          <button
            type="button"
            data-testid="resend-signing-emails"
            disabled={resending}
            onClick={onResend}
            className="inline-flex items-center gap-2 h-10 px-4 rounded-xl text-sm font-semibold border border-[color:var(--color-brand-navy)] text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-sky-soft)] transition-colors disabled:opacity-60"
          >
            {resending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            {resending ? "Resending…" : "Resend signing emails"}
          </button>
          {resendOk && (
            <span className="text-xs text-[color:var(--color-success)] inline-flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Digio re-triggered — fresh emails on their way.
            </span>
          )}
          {resendError && (
            <span className="text-xs text-[color:var(--color-danger)]">
              {resendError}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
