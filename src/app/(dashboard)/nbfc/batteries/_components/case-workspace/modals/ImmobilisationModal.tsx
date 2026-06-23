"use client";

import { useState } from "react";
import { ModalShell } from "./ModalShell";
import AuditTrailPreview from "../AuditTrailPreview";

interface Props {
  open: boolean;
  onClose: () => void;
  loanApplicationId: string;
  imei: string | null;
  batteryCode: string;
  borrowerName: string | null;
  outstanding: number | null;
  lenderLegalName: string;
  grievanceUrl: string;
  helpline: string;
  onSubmitted: () => void;
}

// API enum: dpd_60 | dpd_90 | fraud_flag | manual. Surface friendly labels.
const REASON_OPTIONS: Array<{
  label: string;
  reason_code: "dpd_60" | "dpd_90" | "fraud_flag" | "manual";
}> = [
  { label: "EMI overdue 60+ days", reason_code: "dpd_60" },
  { label: "EMI overdue 90+ days", reason_code: "dpd_90" },
  { label: "Fraud flag confirmed", reason_code: "fraud_flag" },
  {
    label: "EMI overdue + high CDS + usage anomaly",
    reason_code: "manual",
  },
];

export function ImmobilisationModal({
  open,
  onClose,
  loanApplicationId,
  imei,
  batteryCode,
  borrowerName,
  outstanding,
  lenderLegalName,
  grievanceUrl,
  helpline,
  onSubmitted,
}: Props) {
  const [reasonIdx, setReasonIdx] = useState<number | "">("");
  const [noticeConfirmed, setNoticeConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choice =
    typeof reasonIdx === "number" ? REASON_OPTIONS[reasonIdx] : null;
  const canSubmit = Boolean(choice && noticeConfirmed && imei);

  async function submit() {
    if (!canSubmit || !choice || !imei) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        "/api/nbfc/actions/battery-immobilisation/initiate",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            loan_application_id: loanApplicationId,
            imei,
            reason_code: choice.reason_code,
            reviewed_evidence_ack: true,
          }),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        setError(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
        return;
      }
      onSubmitted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const formattedOutstanding =
    outstanding != null ? `₹${outstanding.toLocaleString("en-IN")}` : "the overdue amount";

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="You are about to request battery immobilisation"
      caseSubtitle={`${batteryCode} · ${borrowerName ?? "—"}`}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg border border-[color:var(--color-border)] px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit || submitting}
            className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-bold text-white disabled:opacity-40"
            data-testid="immobilisation-modal-submit"
          >
            {submitting ? "Submitting…" : "Submit for approval"}
          </button>
        </>
      }
    >
      <section>
        <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-[color:var(--color-ink-muted)]">
          What will happen
        </p>
        <ol className="ml-1 list-decimal space-y-1 pl-5 text-sm">
          <li>Request routed to your Risk Head for approval (two-person governance check)</li>
          <li>On approval, immobilisation command sent only when battery is stationary &amp; ignition off</li>
          <li>Borrower notified via SMS + App with lender identity, LSP identity, grievance URL and reversal path</li>
          <li>Audit log entry records requester, both approvers, reason code and reversibility window</li>
        </ol>
      </section>

      <section className="rounded-lg border border-sky-200 bg-sky-50/60 p-3">
        <p className="text-[10px] font-bold uppercase tracking-widest text-sky-700">
          🛡 Approval required
        </p>
        <ul className="mt-1 space-y-0.5 text-sm">
          <li>
            <span className="font-semibold">Risk Head</span> · ~2 hrs
          </li>
        </ul>
      </section>

      <section>
        <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-red-600">
          Reason code (required)
        </p>
        <select
          value={reasonIdx}
          onChange={(e) =>
            setReasonIdx(e.target.value === "" ? "" : Number(e.target.value))
          }
          className="w-full rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-3 py-2 text-sm"
        >
          <option value="">Select a reason</option>
          {REASON_OPTIONS.map((r, idx) => (
            <option key={r.label} value={idx}>
              {r.label}
            </option>
          ))}
        </select>
      </section>

      <section className="rounded-lg border border-amber-300 bg-amber-50/40 p-4">
        <p className="text-[10px] font-bold uppercase tracking-widest text-amber-800">
          🗎 Borrower notice · exact copy
        </p>
        <div className="mt-2 space-y-2 text-sm text-[color:var(--color-ink)]">
          <p>Dear {borrowerName ?? "Borrower"},</p>
          <p>
            Your loan <code className="rounded bg-amber-100 px-1">{loanApplicationId}</code>{" "}
            with <strong>{lenderLegalName} (NBFC)</strong> is currently overdue.
            Outstanding amount: <strong>{formattedOutstanding}</strong>.
          </p>
          <p>
            As part of our recovery process — delivered through our Loan Service
            Provider <strong>iTarang Battery Solutions (LSP)</strong> — we are
            initiating a <em>battery immobilisation</em> on the battery financed
            under this loan.
          </p>
          <p>
            <strong>Restoration steps:</strong> settle the overdue amount via the
            NBFC app or call our helpline below. Restoration typically completes
            within 2–4 hours after dual-approval verification.
          </p>
          <p className="text-emerald-700">
            <strong>Reversibility:</strong> Yes — re-mobilisation within 2–4
            hours after EMI settlement + dual approval
          </p>
          <p className="text-xs italic text-[color:var(--color-ink-muted)]">
            This action is taken in accordance with your loan agreement dated
            at origination and with the RBI Digital Lending Directions 2025. It
            is a non-coercive measure intended only to protect the financed
            asset.
          </p>
          <p className="text-xs">
            🌐 Grievance:{" "}
            <a
              href={grievanceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-700 underline"
            >
              {grievanceUrl}
            </a>{" "}
            · 📞 Helpline: <span className="font-mono">{helpline}</span>
          </p>
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={noticeConfirmed}
            onChange={(e) => setNoticeConfirmed(e.target.checked)}
            data-testid="immobilisation-notice-confirmed"
          />
          I confirm the borrower notice above is accurate and will be sent
          verbatim on approval.
        </label>
      </section>

      <AuditTrailPreview
        batteryCode={batteryCode}
        actionLabel="Request Immobilisation"
        reason={choice?.label ?? ""}
        approverChain={["Risk Head"]}
        includesBorrowerNotice
      />

      <p className="text-[11px] text-[color:var(--color-ink-muted)]">
        This action complies with RBI Digital Lending Directions 2025 and the
        Fair Practices Code.
      </p>

      {!imei ? (
        <p className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          No IMEI is linked to this loan — immobilisation cannot be dispatched
          until the battery is registered.
        </p>
      ) : null}

      {error ? (
        <p
          data-testid="immobilisation-modal-error"
          className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800"
        >
          {error}
        </p>
      ) : null}
    </ModalShell>
  );
}

export default ImmobilisationModal;
